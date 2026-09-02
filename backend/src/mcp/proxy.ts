import { createServer, type Server, type Socket } from 'net';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import db from '../db/index.js';
import { evaluateRequest, maskSecrets, hasEnvSecretContext, markSessionEnv, isEnvBlockEnabled } from '../policy/engine.js';
import { broadcast } from '../realtime/hub.js';
import { isProxyIngressUrl } from '../agent-det/detector.js';
import { JsonRpcFramer // v2 audit leak fix, serializeMessage, serializeMessageLine, synthesizeError, buildDenyError, denyMessage, type JsonRpcMessage } from './framer.js';

// MCP proxy: spawns each registered MCP server (mcp_servers table) as a child
// process and interposes on the stdio JSON-RPC stream. Every inbound request
// is evaluated by the policy engine BEFORE it is forwarded:
//   allow -> forward to child, pipe response back, audit_log (allow)
//   deny  -> synthesize JSON-RPC error, do NOT forward, audit_log (deny)
//   log   -> forward AND audit_log (log)
// See ADR-proxy-transport.md for the transport decision.

export const PROXY_PORT = parseInt(process.env.CF_PROXY_PORT || '3001', 10);
// HTTP MCP ingress (P12): real agents such as OpenCode (`type: remote`,
// streamable HTTP / SSE) cannot dial the raw-TCP JSON-RPC ingress on 3001;
// their configs are rewritten to point at http://127.0.0.1:3002/<server>.
// See backend/ADR-proxy-injection.md for the transport decision.
export const PROXY_HTTP_PORT = parseInt(process.env.CF_PROXY_HTTP_PORT || '3002', 10);

interface McpServerRow {
  name: string;
  type: string;
  url: string | null;
  command: string | null;
  args: string | null;
  env: string | null;
}

interface SpawnedServer {
  name: string;
  command: string;
  args: string[];
  child: ChildProcess;
  responseHandlers: Map<number | string, (msg: JsonRpcMessage) => void>;
  ready: boolean;
  initError?: string;
  initResult?: unknown;
  pending: { wire: JsonRpcMessage; resolve: (ok: boolean, err: string) => void }[];
}

export interface ProxyRequestResult {
  ok: boolean;
  decision: 'allow' | 'deny' | 'log';
  result?: unknown;
  error?: string;
  durationMs: number;
}

interface RequestContext {
  agent: string;
  id: number | string | null;
  method: string;
  params: unknown;
  raw: string;
  // Session-scoped env-context key (TCP connection id / HTTP remote key).
  // The env block is session-wide — once a session carries env/API/JWT
  // context, every further call from it is denied with ENV_BLOCK_MESSAGE.
  sessionKey: string;
}

const servers = new Map<string, SpawnedServer>();
let tcpServer: Server | null = null;
const sockets = new Set<Socket>();

// Firewall enable state is read from the settings table (written by the UI
// toggle) and cached for a short TTL so every request doesn't hit SQLite.
// When disabled the proxy skips policy evaluation entirely and forwards
// everything, auditing the bypass explicitly.
let fwEnabledCache: { value: boolean; at: number } = { value: true, at: 0 };
const FW_CACHE_TTL_MS = 2000;

function isFirewallEnabled(): boolean {
  const now = Date.now();
  if (now - fwEnabledCache.at > FW_CACHE_TTL_MS) {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'firewall_enabled'")
      .get() as { value: string } | undefined;
    fwEnabledCache = { value: row ? row.value !== 'false' : true, at: now };
  }
  return fwEnabledCache.value;
}

function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

// Deny webhook: when a webhook_url setting is configured, every deny decision
// fires a real POST with the audit payload (fire-and-forget; failures never
// affect the request path).
function fireDenyWebhook(
  ctx: RequestContext,
  serverName: string,
  decision: string,
  reason: string,
  durationMs: number,
): void {
  const url = getSetting('webhook_url');
  if (!url) return;
  const payload = {
    event: 'mcp-firewall.deny',
    timestamp: new Date().toISOString(),
    tool: (ctx.params as { name?: string } | null)?.name ?? ctx.method,
    method: ctx.method,
    agent: ctx.agent,
    server: serverName,
    decision,
    reason,
    duration_ms: Math.round(durationMs),
  };
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((r) => r.arrayBuffer().catch(() => {}))
    .catch((err: Error) => {
      console.error(`[proxy] Deny webhook POST failed: ${err.message}`);
    });
}

const insertAuditStmt = db.prepare(`
  INSERT INTO audit_log (id, timestamp, agent, tool, method, params, decision, reason, duration_ms, session_id, raw_request, server)
  VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function parseArgs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* fall through to whitespace split */
  }
  return raw.split(' ').filter(Boolean);
}

function parseEnv(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Audit storage decision (P5-N3): large param/result blobs (base64
// screenshots, file dumps, huge data: URLs) must NOT be persisted verbatim —
// they bloat audit_log and are unrecoverable anyway once masked. Blobs above
// AUDIT_MAX_BLOB_BYTES are truncated to a JSON marker carrying the original
// byte length + a preview, so audit rows stay small and the size is still
// queryable. Responses are never stored at all (maskSecrets is applied to
// params only); this threshold governs the params + raw_request columns.
export const AUDIT_MAX_BLOB_BYTES = 50_000;

function truncateBlobForAudit(raw: string): string {
  if (raw.length <= AUDIT_MAX_BLOB_BYTES) return raw;
  return JSON.stringify({
    __truncated: true,
    byte_length: raw.length,
    preview: raw.slice(0, AUDIT_MAX_BLOB_BYTES),
  });
}

// raw_request must receive the SAME secret masking as params before it is
// persisted — an unmasked raw request would be its own leak (the whole point
// of the deny). The object-level mask (key names + patterns) is reused so
// both columns redact identically; a non-JSON raw falls back to the string
// as-is.
function maskRawRequest(raw: string): string {
  try {
    return JSON.stringify(maskSecrets(JSON.parse(raw)));
  } catch {
    return raw;
  }
}

// MCP session handshake methods — noise in the audit trail (every agent
// fires them on connect), so rows are never persisted for these.
const HANDSHAKE_METHODS = new Set(['initialize', 'notifications/initialized']);

// Internal proxy traffic: discoverToolsHttp declares itself as
// 'context-fence-proxy' when it syncs tools through the ingress. That is the
// firewall's OWN plumbing, not agent activity — policy-checking it lets a
// server-scoped user rule block tool discovery (the endless
// "Blocked: tools/list on playwright" loop), and auditing it pollutes the
// trail + inflates call stats with machine noise.
const INTERNAL_PROXY_AGENT = 'context-fence-proxy';
function isInternalProxyTraffic(ctx: RequestContext): boolean {
  return ctx.agent === INTERNAL_PROXY_AGENT;
}

// Single policy entry point: internal traffic bypasses evaluation entirely.
function evaluatePolicy(
  ctx: RequestContext,
  serverName: string,
  run: () => ReturnType<typeof evaluateRequest>,
): ReturnType<typeof evaluateRequest> {
  if (isInternalProxyTraffic(ctx)) {
    return { decision: 'allow', reason: 'internal proxy sync', rule: 'internal', durationMs: 0 };
  }
  return run();
}

function writeAudit(
  ctx: RequestContext,
  serverName: string,
  decision: string,
  reason: string,
  durationMs: number,
): void {
  if (HANDSHAKE_METHODS.has(ctx.method)) return;
  // Internal proxy sync/discovery is never persisted — see INTERNAL_PROXY_AGENT.
  if (isInternalProxyTraffic(ctx)) return;
  const paramsObj = ctx.params && typeof ctx.params === 'object' ? ctx.params : {};
  const tool = (paramsObj as { name?: string }).name ?? ctx.method;
  // Mask known secret patterns before persisting — audit_log must never
  // store raw API keys / tokens / secrets.
  const maskedParams = ctx.params === undefined
    ? null
    : truncateBlobForAudit(JSON.stringify(maskSecrets(ctx.params)));
  insertAuditStmt.run(
    randomUUID(),
    ctx.agent,
    tool,
    ctx.method,
    maskedParams,
    decision,
    reason,
    Math.round(durationMs),
    ctx.id === null ? null : String(ctx.id),
    ctx.raw ? truncateBlobForAudit(maskRawRequest(ctx.raw)) : null,
    serverName,
  );
  // Realtime push — synchronous, no await, must never throw. Payload is a
  // refetch hint only (audit rows stay small; clients re-pull via REST).
  try {
    broadcast('audit.new', { server: serverName, tool, decision });
  } catch {
    /* broadcast must never take down the proxy path */
  }
}

// Failure-audit throttle: a dead/unreachable MCP server must not fill the
// audit log with one row per request (agents retry aggressively). At most one
// failure audit per server per window (30s) is persisted; live traffic on a
// healthy server is unaffected (writeAudit is only bypassed for failures).
const failureAuditWindow = new Map<string, number>();
const FAILURE_AUDIT_MS = 30_000;
function writeFailureAudit(ctx: RequestContext, serverName: string, reason: string, durationMs: number): void {
  const now = Date.now();
  const last = failureAuditWindow.get(serverName) ?? 0;
  if (now - last < FAILURE_AUDIT_MS) return;
  failureAuditWindow.set(serverName, now);
  writeAudit(ctx, serverName, 'log', reason, durationMs);
}

// Session-contamination detection on the way OUT: an MCP server's response
// can leak env/API/JWT context the request never contained (a shell or
// filesystem tool returning .env contents, an auth response carrying a
// token). If the response carries such context, the SESSION is flagged and
// one realtime audit row is written — subsequent MCP calls from that session
// are then blocked by evaluateRequest's session check. Never throws, never
// blocks the forward path; oversized payloads (screenshots, file dumps) are
// skipped to avoid false positives and CPU cost on huge base64 blobs.
const RESPONSE_SCAN_MAX_BYTES = 100_000;
function scanResponseForEnv(ctx: RequestContext, serverName: string, body: unknown): void {
  try {
    if (!isFirewallEnabled() || !isEnvBlockEnabled() || !ctx.sessionKey) return;
    const text =
      typeof body === 'string'
        ? body
        : Buffer.isBuffer(body)
          ? body.toString('utf-8')
          : JSON.stringify(body ?? '');
    if (!text || text.length > RESPONSE_SCAN_MAX_BYTES) return;
    if (!hasEnvSecretContext(text)) return;
    if (markSessionEnv(ctx.sessionKey)) {
      writeAudit(
        ctx,
        serverName,
        'log',
        'ContextFence: env/ API/ JWT context detected in MCP response — session flagged; subsequent MCP calls from this session will be blocked',
        0,
      );
    }
  } catch {
    /* scan must never take down the forward path */
  }
}

function forwardToChild(server: SpawnedServer, wire: JsonRpcMessage): void {
  const stdin = server.child.stdin;
  if (!stdin || stdin.destroyed) throw new Error('MCP server stdin is closed');
  // Official MCP stdio servers expect newline-delimited JSON on stdin.
  stdin.write(serializeMessageLine(wire));
}

function forwardToChildWhenReady(server: SpawnedServer, wire: JsonRpcMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.ready) {
      try {
        forwardToChild(server, wire);
        resolve();
      } catch (err) {
        reject(err);
      }
      return;
    }
    // Real MCP servers reject tool calls before initialize completes, so
    // buffer inbound requests until the handshake finished.
    server.pending.push({
      wire,
      resolve: (ok, err) => (ok ? resolve() : reject(new Error(err))),
    });
  });
}

function getFirstServer(): SpawnedServer | null {
  for (const server of servers.values()) {
    if (server.child.stdin && !server.child.stdin.destroyed) return server;
  }
  return null;
}

/**
 * Core decision path: evaluate one inbound request, then forward / deny / log.
 * `respond` delivers a JSON-RPC message back to the original caller.
 */
function decideAndForward(
  ctx: RequestContext,
  server: SpawnedServer,
  respond: (msg: JsonRpcMessage) => void,
): void {
  const t0 = Date.now();

  // Firewall disabled: bypass policy evaluation, forward everything, and
  // record the bypass so the audit trail explains the allow.
  if (!isFirewallEnabled()) {
    const wire: JsonRpcMessage = { jsonrpc: '2.0', method: ctx.method, params: ctx.params };
    if (ctx.id !== null) wire.id = ctx.id;

    if (ctx.id === null) {
      forwardToChildWhenReady(server, wire)
        .then(() => writeAudit(ctx, server.name, 'allow', 'firewall disabled', Date.now() - t0))
        .catch((err: Error) => {
          writeAudit(ctx, server.name, 'allow', `firewall disabled (forward failed: ${err.message})`, Date.now() - t0);
        });
      return;
    }

    server.responseHandlers.set(ctx.id, (resp) => {
      respond(resp);
      writeAudit(ctx, server.name, 'allow', 'firewall disabled', Date.now() - t0);
    });
    forwardToChildWhenReady(server, wire).catch((err: Error) => {
      if (ctx.id !== null) server.responseHandlers.delete(ctx.id);
      respond(synthesizeError(ctx.id, err.message));
      writeAudit(ctx, server.name, 'allow', `firewall disabled (forward failed: ${err.message})`, Date.now() - t0);
    });
    return;
  }

  const result = evaluatePolicy(ctx, server.name, () => evaluateRequest(ctx.method, ctx.params, server.name, ctx.sessionKey));

  if (result.decision === 'deny') {
    if (ctx.id !== null) respond(buildDenyError(ctx.id, result.reason));
    writeAudit(ctx, server.name, 'deny', result.reason, Date.now() - t0);
    fireDenyWebhook(ctx, server.name, 'deny', result.reason, Date.now() - t0);
    return;
  }

  // allow | log
  const wire: JsonRpcMessage = { jsonrpc: '2.0', method: ctx.method, params: ctx.params };
  if (ctx.id !== null) wire.id = ctx.id;

  if (ctx.id === null) {
    // Notification: no response expected, audit immediately.
    forwardToChildWhenReady(server, wire)
      .then(() => writeAudit(ctx, server.name, result.decision, result.reason, Date.now() - t0))
      .catch((err: Error) => {
        writeAudit(ctx, server.name, result.decision, err.message, Date.now() - t0);
      });
    return;
  }

  server.responseHandlers.set(ctx.id, (resp) => {
    scanResponseForEnv(ctx, server.name, resp);
    respond(resp);
    const reason = resp.error?.message ?? result.reason;
    writeAudit(ctx, server.name, result.decision, reason, Date.now() - t0);
  });
  forwardToChildWhenReady(server, wire).catch((err: Error) => {
    if (ctx.id !== null) server.responseHandlers.delete(ctx.id);
    respond(synthesizeError(ctx.id, err.message));
    writeAudit(ctx, server.name, result.decision, err.message, Date.now() - t0);
  });
}

function handleChildMessage(server: SpawnedServer, msg: JsonRpcMessage): void {
  if (msg.id === undefined || msg.id === null) return;
  const handler = server.responseHandlers.get(msg.id);
  if (handler) {
    server.responseHandlers.delete(msg.id);
    handler(msg);
  }
}

// GUI-invoked backends (Dock/Finder, launchd) inherit a minimal PATH that does
// not include Homebrew/nvm/node bins, so bare commands like `npx` or `node`
// fail to spawn with ENOENT. Assemble every known bin location (inherited PATH
// first, then common install dirs) so both executable resolution and the
// spawned child's own environment can find `npx`/`node`/`npm`.
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

const IS_WIN = process.platform === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';
// Windows resolves npx/npm/node through .cmd/.exe shims — a bare filename
// never exists on disk, so probe the platform's real extensions too.
const WINDOWS_EXTS = IS_WIN ? ['', '.cmd', '.exe', '.bat'] : [''];

function buildBinDirs(): string[] {
  const dirs: string[] = [];
  for (const d of (process.env.PATH || '').split(PATH_SEP).filter(Boolean)) dirs.push(d);
  for (const d of COMMON_BIN_DIRS) {
    if (!dirs.includes(d)) dirs.push(d);
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const voltaBin = join(home, '.volta', 'bin');
    if (!dirs.includes(voltaBin)) dirs.push(voltaBin);
    try {
      const nvmRoot = join(home, '.nvm', 'versions', 'node');
      for (const v of readdirSync(nvmRoot)) {
        const d = join(nvmRoot, v, 'bin');
        if (!dirs.includes(d)) dirs.push(d);
      }
    } catch { /* no nvm install */ }
  }
  const selfBin = dirname(process.execPath);
  if (!dirs.includes(selfBin)) dirs.push(selfBin);
  return dirs;
}

function resolveCommand(cmd: string): string {
  if (cmd.includes('/') || cmd.includes('\\')) return cmd;
  for (const d of buildBinDirs()) {
    for (const ext of WINDOWS_EXTS) {
      if (existsSync(join(d, cmd + ext))) return join(d, cmd + ext);
    }
  }
  // Fall back to this backend's own node installation (covers `node` and `npx`
  // when the only Node lives under nvm/Volta with no PATH entry).
  if (cmd === 'node') return process.execPath;
  if (cmd === 'npx') {
    const npxBin = join(dirname(process.execPath), IS_WIN ? 'npx.cmd' : 'npx');
    if (existsSync(npxBin)) return npxBin;
  }
  return cmd; // leave as-is; spawn surfaces a clearer ENOENT error
}

function spawnMcpServer(row: McpServerRow): SpawnedServer | null {
  if (!row.command) return null;
  const command = resolveCommand(row.command);
  const args = parseArgs(row.args);
  const env = parseEnv(row.env);
  // Merge row env over ours, then guarantee the child can locate node/npx no
  // matter how this process itself was launched (Dock/Finder => minimal PATH).
  // Windows PATH is ';'-separated — joining with ':' produces one bogus entry
  // and every spawn fails with ENOENT.
  const childEnv: NodeJS.ProcessEnv = env ? { ...process.env, ...env } : { ...process.env };
  childEnv.PATH = buildBinDirs().join(PATH_SEP);
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      detached: true,
      // .cmd/.bat shims (npx.cmd, node.cmd) are not directly executable —
      // cmd.exe must run them. shell:true is the canonical Windows path.
      shell: IS_WIN,
      windowsHide: true,
    });
  } catch (err) {
    console.error(`[proxy] Failed to spawn MCP server "${row.name}":`, err);
    return null;
  }

  const server: SpawnedServer = {
    name: row.name,
    command: row.command,
    args,
    child,
    responseHandlers: new Map(),
    ready: false,
    pending: [],
  };

  // Real MCP servers reject tool calls until initialize completes: run the
  // handshake at spawn and buffer inbound requests until it finishes.
  const INIT_ID = '__cf_init__';
  server.responseHandlers.set(INIT_ID, (msg) => {
    if (msg.error) server.initError = msg.error.message ?? 'initialize rejected';
    else server.initResult = msg.result;
    try {
      if (server.child.stdin && !server.child.stdin.destroyed) {
        server.child.stdin.write(
          serializeMessageLine({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
        );
      }
    } catch { /* child gone */ }
    server.ready = true;
    const flush = server.pending;
    server.pending = [];
    for (const p of flush) {
      try {
        forwardToChild(server, p.wire);
        p.resolve(true, '');
      } catch (err) {
        p.resolve(false, (err as Error).message);
      }
    }
  });
  try {
    server.child.stdin?.write(
      serializeMessageLine({
        jsonrpc: '2.0',
        id: INIT_ID,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'context-fence-proxy', version: '1.0.0-beta' },
        },
      }),
    );
  } catch { /* child gone */ }
  setTimeout(() => {
    if (server.ready) return;
    console.warn(`[proxy] ${row.name}: initialize handshake timed out; proceeding anyway`);
    server.ready = true;
    const flush = server.pending;
    server.pending = [];
    for (const p of flush) {
      try {
        forwardToChild(server, p.wire);
        p.resolve(true, '');
      } catch (err) {
        p.resolve(false, (err as Error).message);
      }
    }
  }, 8000);

  const framer = new JsonRpcFramer // v2 audit leak fix();
  child.stdout?.on('error', () => {});
  child.stdout?.pipe(framer);
  framer.on('data', (msg: JsonRpcMessage) => handleChildMessage(server, msg));
  framer.on('error', (err: Error) => {
    console.error(`[proxy] Response framer error (${row.name}): ${err.message}`);
  });

  child.stderr?.on('data', (data: Buffer) => {
    if (process.env.CF_DEBUG) {
      process.stderr.write(`[proxy:${row.name}:stderr] ${data.toString()}`);
    }
  });
  child.stdin?.on('error', () => {});
  child.on('error', (err: Error) => {
    console.error(`[proxy] Child process error (${row.name}): ${err.message}`);
    servers.delete(row.name);
  });
  child.on('exit', (code, signal) => {
    console.log(`[proxy] MCP server "${row.name}" exited (code=${code} signal=${signal})`);
    for (const [id, handler] of server.responseHandlers) {
      handler(synthesizeError(id, 'MCP server exited'));
    }
    server.responseHandlers.clear();
    servers.delete(row.name);
  });

  console.log(
    `[proxy] Spawned MCP server "${row.name}" (pid=${child.pid}) via ${row.command} ${args.join(' ')}`,
  );
  return server;
}

function const BATCH_LIMIT_BYTES // v2: abrupt disconnect guard = 256*1024; // v2
function handleSocket(socket: Socket): void {
  sockets.add(socket);
  const agentName = `tcp:${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 'unknown'}`;
  // Real agent identity (P11-N5): the MCP spec requires the client to declare
  // itself in the initialize handshake (clientInfo.name). Capture it once per
  // connection and tag every audit row from this socket with it; before the
  // handshake (or when a client never sends initialize) the transport tag
  // above is the honest truth. The initialize request itself is audited with
  // the name it declared.
  let declaredClient: string | null = null;
  const framer = new JsonRpcFramer // v2 audit leak fix();

  socket.on('error', () => {});
  socket.pipe(framer);
  framer.on('data', (msg: JsonRpcMessage) => {
    if (declaredClient === null && msg.method === 'initialize') {
      const info = (msg.params as { clientInfo?: { name?: unknown } } | null)?.clientInfo;
      if (info && typeof info.name === 'string' && info.name.trim()) {
        declaredClient = info.name.trim();
      }
    }
    if (Array.isArray(msg)) {
      // JSON-RPC batch frames are not part of MCP and silently swallowing them
      // would let every request inside the batch bypass evaluation + audit.
      const server = getFirstServer();
      const ctx: RequestContext = {
        agent: agentName,
        id: null,
        method: 'batch',
        params: null,
        raw: JSON.stringify(msg),
        sessionKey: agentName,
      };
      const reason = 'Invalid request: JSON-RPC batch requests are not supported by the MCP proxy';
      if (server) writeAudit(ctx, server.name, 'deny', reason, 0);
      if (!socket.destroyed) {
        socket.write(serializeMessage(synthesizeError(null, reason)));
      }
      return;
    }
    if (!msg.method) return; // not an evaluatable request
    const server = getFirstServer();
    if (!server) {
      if (msg.id !== null && msg.id !== undefined) {
        socket.write(serializeMessage(synthesizeError(msg.id, 'No MCP server running')));
      }
      return;
    }
    const ctx: RequestContext = {
      agent: declaredClient ?? agentName,
      id: msg.id === undefined ? null : msg.id,
      method: msg.method,
      params: msg.params,
      raw: JSON.stringify(msg),
      sessionKey: agentName,
    };
    decideAndForward(ctx, server, (resp) => {
      if (!socket.destroyed) socket.write(serializeMessage(resp));
    });
  });
  framer.on('error', (err: Error) => {
    console.error(`[proxy] Client framer error: ${err.message}`);
  });
  socket.on('close', () => {
    sockets.delete(socket);
  });
}

/**
 * Programmatic entry point used by /api/test-mcp: runs the same
 * evaluate-then-forward path as the TCP ingress and resolves with the real
 * decision + real response/error from the spawned MCP server.
 */
export async function sendRequest(
  serverName: string,
  method: string,
  params: unknown,
): Promise<ProxyRequestResult> {
  const server = servers.get(serverName) || getFirstServer();
  if (!server) {
    return { ok: false, decision: 'log', error: 'No MCP server running', durationMs: 0 };
  }

  const id = (sendRequest as unknown as { nextId?: number }).nextId ?? 1;
  (sendRequest as unknown as { nextId?: number }).nextId = id + 1;

  const t0 = Date.now();
  const ctx: RequestContext = {
    agent: `api:${serverName}`,
    id,
    method,
    params,
    raw: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    // The dashboard's test probe is its own session per call — a previous
    // test must never poison the next one.
    sessionKey: `api:${serverName}:${id}`,
  };

  // Firewall disabled: same bypass as the TCP ingress — forward, audit the
  // bypass as allow / 'firewall disabled'.
  if (!isFirewallEnabled()) {
    writeAudit(ctx, server.name, 'allow', 'firewall disabled', Date.now() - t0);
    return new Promise((resolve) => {
      server.responseHandlers.set(id, (resp) => {
        resolve({
          ok: !resp.error,
          decision: 'allow',
          result: resp.result,
          error: resp.error?.message,
          durationMs: Date.now() - t0,
        });
      });
      forwardToChildWhenReady(server, { jsonrpc: '2.0', id, method, params }).catch((err: Error) => {
        server.responseHandlers.delete(id);
        resolve({ ok: false, decision: 'allow', error: err.message, durationMs: Date.now() - t0 });
      });
    });
  }

  const result = evaluatePolicy(ctx, server.name, () => evaluateRequest(method, params, server.name, ctx.sessionKey));

  if (result.decision === 'deny') {
    writeAudit(ctx, server.name, 'deny', result.reason, Date.now() - t0);
    fireDenyWebhook(ctx, server.name, 'deny', result.reason, Date.now() - t0);
    return { ok: false, decision: 'deny', error: denyMessage(result.reason), durationMs: Date.now() - t0 };
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.responseHandlers.delete(id);
      resolve({
        ok: false,
        decision: result.decision,
        error: 'MCP server timeout',
        durationMs: Date.now() - t0,
      });
    }, 10000);
    server.responseHandlers.set(id, (resp) => {
      clearTimeout(timer);
      scanResponseForEnv(ctx, server.name, resp);
      const reason = resp.error?.message ?? result.reason;
      writeAudit(ctx, server.name, result.decision, reason, Date.now() - t0);
      resolve(
        resp.error
          ? {
              ok: false,
              decision: result.decision,
              error: resp.error.message,
              result: resp.result,
              durationMs: Date.now() - t0,
            }
          : {
              ok: true,
              decision: result.decision,
              result: resp.result,
              durationMs: Date.now() - t0,
            },
      );
    });
    forwardToChildWhenReady(server, { jsonrpc: '2.0', id, method, params }).catch((err: Error) => {
      clearTimeout(timer);
      server.responseHandlers.delete(id);
      const message = err.message;
      writeAudit(ctx, server.name, result.decision, message, Date.now() - t0);
      resolve({ ok: false, decision: result.decision, error: message, durationMs: Date.now() - t0 });
    });
  });
}

// Settings-page "Test Webhook" helper: fires a synthetic deny payload to the
// configured webhook so the wiring can be validated without a real deny.
export async function testDenyWebhook(): Promise<{ sent: boolean; url: string | null }> {
  const url = getSetting('webhook_url');
  if (!url) return { sent: false, url: null };
  const payload = {
    event: 'mcp-firewall.test',
    timestamp: new Date().toISOString(),
    tool: 'test_tool',
    method: 'tools/call',
    agent: 'settings-ui',
    server: 'test',
    decision: 'deny',
    reason: 'Webhook test from Settings',
    duration_ms: 0,
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await r.arrayBuffer().catch(() => {});
    return { sent: r.ok, url };
  } catch {
    return { sent: false, url };
  }
}

export function getSpawnedServers(): { name: string; pid: number | undefined; command: string }[] {  return [...servers.values()].map((s) => ({
    name: s.name,
    pid: s.child.pid,
    command: `${s.command} ${s.args.join(' ')}`,
  }));
}

/**
 * Test Connection (GUI "Add MCP Server"): spawns the candidate config through
 * the REAL proxy spawn path (same stdio transport, JsonRpcFramer // v2 audit leak fix, initialize
 * handshake as a live server), waits for the handshake, then sends a real
 * `ping` over that transport. The child is ephemeral — killed and dropped from
 * the server map afterwards, nothing is registered. A bad token / missing
 * dependency surfaces here (initialize fails or times out), before anything
 * is committed to the mcp_servers table.
 */
export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  handshakeMs: number;
}

export async function testMcpConnection(cfg: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): Promise<TestConnectionResult> {
  const key = `__test__${Date.now()}`;
  const row: McpServerRow = {
    name: key,
    type: 'stdio',
    url: null,
    command: cfg.command,
    args: cfg.args && cfg.args.length > 0 ? JSON.stringify(cfg.args) : null,
    env: cfg.env && Object.keys(cfg.env).length > 0 ? JSON.stringify(cfg.env) : null,
  };
  const spawned = spawnMcpServer(row);
  if (!spawned) return { ok: false, error: 'Failed to spawn the process', handshakeMs: 0 };
  servers.set(key, spawned);

  const t0 = Date.now();
  try {
    // Wait for the real initialize handshake (same readiness signal live
    // servers use). spawmMcpServer resolves ready on the initialize response
    // or after its own 8s timeout; poll up to 9s to observe the outcome.
    const ready = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (spawned.ready || Date.now() - started > 9000) {
          clearInterval(poll);
          resolve(spawned.ready);
        }
      }, 50);
    });
    if (!ready) {
      return {
        ok: false,
        error: 'Server did not complete the initialize handshake — invalid token, missing dependency, or broken config',
        handshakeMs: Date.now() - t0,
      };
    }

    // The server answered initialize but rejected it (auth error, bad config).
    // Surface its own message — this is the "wrong token" case.
    if (spawned.initError) {
      return {
        ok: false,
        error: `Server rejected the connection during handshake: ${spawned.initError}`,
        handshakeMs: Date.now() - t0,
      };
    }

    // Handshake OK — one real ping over the same transport.
    const ping = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const id = '__cf_test_ping__';
      const timer = setTimeout(() => {
        spawned.responseHandlers.delete(id);
        resolve({ ok: false, error: 'Ping timed out (server accepted initialize but never answered)' });
      }, 10000);
      spawned.responseHandlers.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg.error ? { ok: false, error: msg.error.message } : { ok: true });
      });
      forwardToChildWhenReady(spawned, { jsonrpc: '2.0', id, method: 'ping', params: {} }).catch((err: Error) => {
        clearTimeout(timer);
        spawned.responseHandlers.delete(id);
        resolve({
          ok: false,
          error:
            err.message === 'MCP server stdin is closed'
              ? 'Server process exited during the test (spawn succeeded but the process died)'
              : err.message,
        });
      });
    });

    return { ok: ping.ok, error: ping.error, handshakeMs: Date.now() - t0 };
  } finally {
    // Tear down the ephemeral child (detached process group).
    const pid = spawned.child.pid;
    if (pid) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }, 1500);
    }
    servers.delete(key);
  }
}

/**
 * Register-time spawn: load the row just written to mcp_servers and bring it
 * up through the real spawn path immediately, so a server added in the UI is
 * live (and testable) without a backend restart.
 */
/**
 * Live tool discovery (connector management): performs a real MCP handshake
 * against the registered connector and returns its `tools/list` inventory.
 * stdio connectors run through the SAME spawn path as live servers
 * (spawnMcpServer + JsonRpcFramer // v2 audit leak fix + initialize handshake); http connectors
 * are probed directly with the stored auth headers (static or OAuth2 token).
 * The child is ephemeral — killed and dropped afterwards, never registered
 * as a live server. Failures return the concrete reason (handshake timeout,
 * auth rejection, upstream unreachable) so the UI can show a "connection
 * failed" state with retry + edit-credentials actions.
 */
export interface DiscoveredToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface DiscoveryResult {
  ok: boolean;
  server: string;
  tools: DiscoveredToolInfo[];
  error?: string;
  durationMs: number;
}

function toolFromListEntry(t: { name?: unknown; description?: unknown; inputSchema?: unknown }): DiscoveredToolInfo | null {
  if (!t || typeof t.name !== 'string' || !t.name.trim()) return null;
  return {
    name: t.name,
    description: typeof t.description === 'string' ? t.description : undefined,
    inputSchema: t.inputSchema ?? undefined,
  };
}

async function discoverToolsStdio(row: McpServerRow & { name: string }): Promise<DiscoveryResult> {
  const t0 = Date.now();
  const key = `__discover__${Date.now()}`;
  const spawned = spawnMcpServer({ ...row, name: key });
  if (!spawned) return { ok: false, server: row.name, tools: [], error: 'Failed to spawn the process', durationMs: Date.now() - t0 };
  servers.set(key, spawned);
  try {
    const ready = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (spawned.ready || Date.now() - started > 9000) {
          clearInterval(poll);
          resolve(spawned.ready);
        }
      }, 50);
    });
    if (!ready) {
      return {
        ok: false,
        server: row.name,
        tools: [],
        error: 'Server did not complete the initialize handshake — invalid token, missing dependency, or broken config',
        durationMs: Date.now() - t0,
      };
    }
    if (spawned.initError) {
      return {
        ok: false,
        server: row.name,
        tools: [],
        error: `Server rejected the connection during handshake: ${spawned.initError}`,
        durationMs: Date.now() - t0,
      };
    }
    const tools = await new Promise<DiscoveredToolInfo[] | { error: string }>((resolve) => {
      const id = '__cf_tools__';
      const timer = setTimeout(() => {
        spawned.responseHandlers.delete(id);
        resolve({ error: 'tools/list timed out (server accepted initialize but never answered)' });
      }, 15000);
      spawned.responseHandlers.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) {
          resolve({ error: msg.error.message });
          return;
        }
        const list = (msg.result as { tools?: unknown[] } | undefined)?.tools;
        const tools = (Array.isArray(list) ? list : [])
          .map((t) => toolFromListEntry(t as { name?: unknown; description?: unknown; inputSchema?: unknown }))
          .filter((t): t is DiscoveredToolInfo => t !== null);
        resolve(tools);
      });
      forwardToChildWhenReady(spawned, { jsonrpc: '2.0', id, method: 'tools/list', params: {} }).catch((err: Error) => {
        clearTimeout(timer);
        spawned.responseHandlers.delete(id);
        resolve({ error: err.message });
      });
    });
    if (!Array.isArray(tools)) {
      return { ok: false, server: row.name, tools: [], error: tools.error, durationMs: Date.now() - t0 };
    }
    return { ok: true, server: row.name, tools, durationMs: Date.now() - t0 };
  } finally {
    const pid = spawned.child.pid;
    if (pid) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }, 1500);
    }
    servers.delete(key);
  }
}

function authHeadersFor(row: HttpMcpServerRow): Promise<Record<string, string>> {
  return (async () => {
    const headers: Record<string, string> = {};
    const oauthToken = await getOauthBearerToken(row);
    const stored = parseStoredHeaders(row.headers);
    if (oauthToken) headers.Authorization = `Bearer ${oauthToken}`;
    else if (stored.Authorization) headers.Authorization = stored.Authorization;
    else {
      for (const [k, v] of Object.entries(stored)) {
        if (k !== '__oauth') headers[k] = v;
      }
    }
    return headers;
  })();
}

async function discoverToolsHttp(row: McpServerRow & { name: string; url: string; headers: string | null; auth_type: string | null }): Promise<DiscoveryResult> {
  const t0 = Date.now();
  // Self-loop guard: never discover through our own ingress (the row's url
  // must be the REAL upstream, never http://127.0.0.1:3002/<name>).
  if (isProxyIngressUrl(row.url)) {
    return {
      ok: false,
      server: row.name,
      tools: [],
      error: `Self-loop: ${row.name} points at Context Fence's own ingress (${row.url}). Re-import this MCP from the agent config to heal.`,
      durationMs: Date.now() - t0,
    };
  }
  const hr: HttpMcpServerRow = { name: row.name, url: row.url, headers: row.headers, authType: row.auth_type };
  const authHeaders = await authHeadersFor(hr);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const session = { id: '' as string | null };

  // One JSON-RPC POST, tolerating both application/json and SSE responses
  // (streamable-http servers may answer with text/event-stream).
  const call = async (
    id: string,
    method: string,
    params: unknown,
  ): Promise<{ result?: { tools?: unknown[] } | unknown; error?: { message: string } }> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...authHeaders,
    };
    if (session.id) headers['Mcp-Session-Id'] = session.id;
    const res = await fetch(row.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal,
    });
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) session.id = sessionId;
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (!res.ok) {
      return { error: { message: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` } };
    }
    if (contentType.includes('text/event-stream')) {
      let found: { result?: { tools?: unknown[] } | unknown; error?: { message: string } } | null = null;
      for (const block of text.split('\n\n')) {
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const parsed = JSON.parse(dataLine.slice(5).trim()) as { id?: string | number; result?: unknown; error?: { message: string } };
          if (parsed.id === id) {
            found = { result: parsed.result as { tools?: unknown[] } | undefined, error: parsed.error };
          }
        } catch { /* skip non-JSON SSE event */ }
      }
      return found ?? { error: { message: 'Server streamed no JSON-RPC response' } };
    }
    try {
      const parsed = JSON.parse(text) as { result?: { tools?: unknown[] } | unknown; error?: { message: string } };
      return parsed;
    } catch {
      return { error: { message: `Non-JSON response: ${text.slice(0, 200)}` } };
    }
  };

  try {
    const init = await call('__cf_init__', 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'context-fence-proxy', version: '1.0.0-beta' },
    });
    if (init.error) {
      return { ok: false, server: row.name, tools: [], error: `Server rejected the connection: ${init.error.message}`, durationMs: Date.now() - t0 };
    }
    const toolsResp = await call('__cf_tools__', 'tools/list', {});
    if (toolsResp.error) {
      return { ok: false, server: row.name, tools: [], error: `tools/list failed: ${toolsResp.error.message}`, durationMs: Date.now() - t0 };
    }
    const list = (toolsResp.result as { tools?: unknown[] } | undefined)?.tools;
    const tools = (Array.isArray(list) ? list : [])
      .map((t) => toolFromListEntry(t as { name?: unknown; description?: unknown; inputSchema?: unknown }))
      .filter((t): t is DiscoveredToolInfo => t !== null);
    return { ok: true, server: row.name, tools, durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      server: row.name,
      tools: [],
      error: `Upstream MCP server unreachable: ${(err as Error).message}`,
      durationMs: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverTools(serverName: string): Promise<DiscoveryResult> {
  const row = db
    .prepare('SELECT name, type, url, command, args, env, headers, auth_type FROM mcp_servers WHERE name = ?')
    .get(serverName) as (McpServerRow & { name: string; headers: string | null; auth_type: string | null }) | undefined;
  if (!row) return { ok: false, server: serverName, tools: [], error: 'Server not registered', durationMs: 0 };
  if (row.type === 'http' || row.url) {
    if (!row.url) return { ok: false, server: serverName, tools: [], error: 'Server has no endpoint URL', durationMs: 0 };
    return discoverToolsHttp(row as McpServerRow & { name: string; url: string; headers: string | null; auth_type: string | null });
  }
  if (!row.command) return { ok: false, server: serverName, tools: [], error: 'Server has no launch command', durationMs: 0 };
  return discoverToolsStdio(row);
}

export function spawnRegisteredServer(name: string): { ok: boolean; error?: string } {
  const row = db
    .prepare('SELECT name, type, url, command, args, env FROM mcp_servers WHERE name = ?')
    .get(name) as McpServerRow | undefined;
  if (!row) return { ok: false, error: 'Server not registered' };
  if (!row.command) return { ok: false, error: 'Server has no launch command' };
  const spawned = spawnMcpServer(row);
  if (!spawned) return { ok: false, error: 'Failed to spawn the process' };
  servers.set(row.name, spawned);
  return { ok: true };
}

export function stopServer(name: string): void {
  const server = servers.get(name);
  if (server) {
    const pid = server.child.pid;
    if (pid) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    servers.delete(name);
  }
}

export interface RegisteredServerStatus {
  name: string;
  type: string;
  url: string | null;
  command: string | null;
  connected: number;
  lastCheck: string | null;
  // Live health check, not a static dot:
  //   connected  -> child process spawned and stdin alive right now
  //   needs-auth -> not running AND the config declares env vars that are
  //                 set to empty (token never provided)
  //   error      -> not running (spawn failed / exited), env present or not
  status: 'connected' | 'error' | 'needs-auth';
  envKeys: string[];
  envSet: boolean;
  missingEnv: string[];
}

export function getRegisteredServers(): RegisteredServerStatus[] {
  const rows = db
    .prepare("SELECT name, type, url, command, args, env, connected, last_check FROM mcp_servers WHERE removed = 0 ORDER BY name")
    .all() as (McpServerRow & { connected: number; last_check: string | null })[];

  return rows.map((r) => {
    const envObj = parseEnv(r.env) ?? {};
    const missingEnv = Object.entries(envObj)
      .filter(([, v]) => !v || String(v).trim() === '')
      .map(([k]) => k);
    const live = servers.get(r.name);
    const running = !!live && !!live.child.stdin && !live.child.stdin.destroyed;

    let status: RegisteredServerStatus['status'] = 'error';
    if (running) status = 'connected';
    else if (missingEnv.length > 0) status = 'needs-auth';

    return {
      name: r.name,
      type: r.type,
      url: r.url,
      command: r.command,
      connected: r.connected,
      lastCheck: r.last_check,
      status,
      envKeys: Object.keys(envObj),
      envSet: Object.keys(envObj).length > 0,
      missingEnv,
    };
  });
}

// Terminate a detached child tree. POSIX: process-group kill (-pid);
// Windows has no kill(-pid) — taskkill /T /F is the tree-kill equivalent.
function killTree(pid: number, signal: string): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch { /* already gone */ }
}

// Shut down every spawned MCP child (and its grandchildren, e.g. chromium)
// when the backend exits — otherwise headless browsers get orphaned.
// Children are spawned detached (own process group) so the whole tree can be
// terminated at once.
function shutdownChildren(): void {
  const pids = [...servers.values()].map((s) => s.child.pid).filter((p): p is number => p !== undefined);
  for (const pid of pids) {
    killTree(pid, 'SIGTERM');
  }
  setTimeout(() => {
    for (const pid of pids) {
      killTree(pid, 'SIGKILL');
    }
  }, 2000);
  setTimeout(() => process.exit(0), 2500);
}
process.on('SIGTERM', shutdownChildren);
process.on('SIGINT', shutdownChildren);
process.on('exit', () => {
  const pids = [...servers.values()].map((s) => s.child.pid).filter((p): p is number => p !== undefined);
  for (const pid of pids) {
    killTree(pid, 'SIGKILL');
  }
});

export async function startProxy(): Promise<void> {
  const rows = db
    .prepare('SELECT name, type, url, command, args, env FROM mcp_servers WHERE command IS NOT NULL')
    .all() as McpServerRow[];

  for (const row of rows) {
    const spawned = spawnMcpServer(row);
    if (spawned) servers.set(row.name, spawned);
  }
  if (servers.size === 0) {
    console.log('[proxy] No MCP servers registered to spawn (mcp_servers table empty)');
  }

  return new Promise((resolve, reject) => {
    const server = createServer(const BATCH_LIMIT_BYTES // v2: abrupt disconnect guard = 256*1024; // v2
function handleSocket);
    server.on('error', reject);
    server.listen(PROXY_PORT, '127.0.0.1', () => {
      console.log(
        `[proxy] MCP proxy listening on port ${PROXY_PORT} (${servers.size} server(s) spawned)`,
      );
      tcpServer = server;
      resolve();
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// P12 — HTTP MCP ingress (real agent traffic)
//
// Real agents do not dial the raw-TCP ingress; their configs are rewritten
// (ADR-proxy-injection.md) to POST JSON-RPC to http://127.0.0.1:3002/<server>.
// This ingress runs the SAME policy path as the TCP one, injects auth the
// agent never sends to the proxy (stored in mcp_servers.headers at protect
// time), forwards to the server's real URL, passes the upstream response
// through untouched, and audits under the identity declared in `initialize`.
// ───────────────────────────────────────────────────────────────────────────

// Per (remote address | server) declared client name, captured once from the
// first `initialize` handshake — the same self-asserted identity model the
// TCP ingress adopted (P11-N5).
const httpClientIdentities = new Map<string, string>();

// ── Legacy HTTP+SSE channel (opencode remote transport) ───────────────────
// opencode's `type: remote` runtime opens a GET on the endpoint expecting an
// SSE stream (the 2024-11-05 HTTP+SSE transport); a plain 405 makes it fail
// with "SSE error: Non-200 status code (405)" even though the modern
// streamable-http POST path works (`opencode mcp debug` succeeds, runtime
// does not). Serve the GET as an SSE stream with an `endpoint` event; POSTs
// from the same client|server then get 202 in-band and their JSON-RPC
// responses are pushed as `message` events on the stream — the spec's
// fallback transport. Clients that never open a GET keep the stateless
// JSON-in-JSON-out path.
interface SseChannel {
  serverName: string;
  res: ServerResponse;
}

const sseChannels = new Map<string, SseChannel>();

function openSseChannel(remoteKey: string, serverName: string, res: ServerResponse): void {
  const prev = sseChannels.get(remoteKey);
  if (prev && !prev.res.writableEnded) {
    try { prev.res.end(); } catch { /* already closed */ }
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Legacy transport: first event tells the client where to POST requests.
  res.write(`event: endpoint\ndata: ${JSON.stringify(`/${serverName}`)}\n\n`);
  const heartbeat = setInterval(() => {
    if (res.writableEnded) { clearInterval(heartbeat); return; }
    res.write(': keep-alive\n\n');
  }, 30000);
  res.on('close', () => {
    clearInterval(heartbeat);
    if (sseChannels.get(remoteKey)?.res === res) sseChannels.delete(remoteKey);
  });
  sseChannels.set(remoteKey, { serverName, res });
}

function getSseChannel(remoteKey: string, serverName: string): SseChannel | null {
  const ch = sseChannels.get(remoteKey);
  if (ch && ch.serverName === serverName && !ch.res.writableEnded) return ch;
  return null;
}

// Deliver one JSON-RPC message to the client: over the active SSE stream
// (202 in-band) when in SSE mode, otherwise inline 200 application/json.
function deliverJsonRpc(res: ServerResponse, sse: SseChannel | null, msg: JsonRpcMessage): void {
  if (sse && !sse.res.writableEnded) {
    if (!res.writableEnded) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end();
    }
    sse.res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
  } else if (!res.writableEnded) {
    writeJson(res, 200, msg);
  }
}

interface HttpMcpServerRow {
  name: string;
  url: string;
  headers: string | null;
  authType: string | null;
}

function getHttpServer(name: string): HttpMcpServerRow | null {
  const row = db
    .prepare('SELECT name, url, headers, auth_type FROM mcp_servers WHERE name = ?')
    .get(name) as { name: string; url: string | null; headers: string | null; auth_type: string | null } | undefined;
  if (!row || !row.url) return null;
  return { name: row.name, url: row.url, headers: row.headers, authType: row.auth_type };
}

// A registered stdio server (command-based, e.g. Playwright MCP) that the
// HTTP ingress can bridge to: real HTTP clients POST JSON-RPC to
// http://127.0.0.1:3002/<name> and the proxy relays to the spawned child.
function getStdioServer(name: string): { name: string; command: string } | null {
  const row = db
    .prepare('SELECT name, command FROM mcp_servers WHERE name = ? AND command IS NOT NULL')
    .get(name) as { name: string; command: string | null } | undefined;
  if (!row || !row.command) return null;
  return { name: row.name, command: row.command };
}

function parseStoredHeaders(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch { /* malformed stored headers */ }
  return {};
}

// ── OAuth2 token handling ─────────────────────────────────────────────────
// Two OAuth shapes coexist in the __oauth block:
//   (a) Authorization-code + PKCE (MCP spec OAuth 2.1, RFC 8707 resource
//       indicators): the Electron main process runs the browser flow and
//       stores the EXCHANGED tokens here (access_token / refresh_token /
//       expires_at). The proxy consumes the stored token, silently renewing
//       it via the refresh_token grant before expiry, and only falls back to
//       the client-credentials grant below when no usable stored token or
//       refresh path exists.
//   (b) Client-credentials (legacy/manual): a headless server-to-server
//       grant against the connector's token_url, with the resource (the
//       server's real URL) passed on every token request.
// The Authorization header the agent's own config would have carried is
// never required: the proxy obtains its own audience-bound token.
const oauthTokens = new Map<string, { token: string; expiresAt: number }>();

interface OauthConfig {
  token_url: string;
  client_id: string;
  client_secret?: string;
  authorization_url?: string;
  scope?: string;
  use_pkce?: boolean;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
  // Set when a refresh was definitively rejected (revoked/invalid): the UI
  // then offers "Reauthorize" instead of a fresh "Connect".
  reauth?: boolean;
}

// The __oauth block is stored as a JSON-ENCODED STRING inside the headers
// object (every write path JSON.stringify's it, matching PATCH's "replaced
// as a unit" contract), but legacy rows may carry a nested object — accept
// both. Values are merged from the block; only token_url + client_id are
// mandatory (a refresh-token path is usable without client_secret).
export function parseOauthBlock(headersRaw: string | null): OauthConfig | null {
  if (!headersRaw) return null;
  try {
    const parsed = JSON.parse(headersRaw) as Record<string, unknown>;
    let oauth: unknown = parsed?.__oauth;
    if (typeof oauth === 'string' && oauth.trim()) {
      try { oauth = JSON.parse(oauth); } catch { return null; }
    }
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return null;
    const cfg = oauth as Partial<OauthConfig>;
    if (!cfg.token_url || !cfg.client_id) return null;
    return {
      token_url: cfg.token_url,
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      authorization_url: cfg.authorization_url,
      scope: cfg.scope,
      use_pkce: cfg.use_pkce !== false,
      access_token: cfg.access_token,
      refresh_token: cfg.refresh_token,
      token_type: cfg.token_type,
      expires_at: typeof cfg.expires_at === 'number' ? cfg.expires_at : undefined,
      reauth: cfg.reauth === true,
    };
  } catch {
    return null;
  }
}

function parseOauthConfig(headersRaw: string | null, authType: string | null): OauthConfig | null {
  if (authType !== 'oauth2' || !headersRaw) return null;
  return parseOauthBlock(headersRaw);
}

// Persist a partial __oauth block update (tokens, expiry) merged over the
// stored block WITHOUT touching the config fields. read-modify-write through
// the headers column; the merged JSON is written back as the canonical
// JSON-string-inside-headers shape.
function storeOauthBlock(row: HttpMcpServerRow, patch: Partial<OauthConfig>): void {
  const stored = parseStoredHeaders(row.headers);
  const block = parseOauthBlock(row.headers) ?? ({} as OauthConfig);
  Object.assign(block, patch);
  stored.__oauth = JSON.stringify(block);
  db.prepare('UPDATE mcp_servers SET headers = ? WHERE name = ?').run(JSON.stringify(stored), row.name);
}

// One POST to a token endpoint with a hard 10s abort (same discipline as
// the MCP discovery fetch): a hung token endpoint must not leak a socket per
// attempt — each leaked socket is an fd, and repeated OAuth retries against
// a hung token_url exhaust the process fd ceiling (EMFILE). Bodies are
// always drained so the connection returns to undici's pool. Returns parsed
// JSON body or null (error already logged).
async function tokenPost(url: string, params: URLSearchParams, context: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[proxy] OAuth token fetch failed (${context}): HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
      return { __httpError: res.status, __body: text, __httpOk: false };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return body;
  } catch (err) {
    const name = (err as Error).name;
    console.error(`[proxy] OAuth token fetch failed (${context}): ${name === 'AbortError' ? 'timed out after 10s' : (err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function saveGrantedTokens(row: HttpMcpServerRow, body: Record<string, unknown>, fallbackLifetimeMs: number): string | null {
  const access = typeof body.access_token === 'string' ? body.access_token : null;
  if (!access) return null;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in * 1000 : fallbackLifetimeMs;
  const expiresAt = Date.now() + expiresIn;
  storeOauthBlock(row, {
    access_token: access,
    refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    token_type: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    expires_at: expiresAt,
    reauth: false,
  });
  console.log(`[proxy] OAuth2 token acquired for ${row.name} (expires in ${Math.round(expiresIn / 1000)}s)`);
  return access;
}

// Silent renewal: use the stored refresh_token BEFORE the stored access
// token expires (30s safety margin). A definitive invalid_grant/revocation
// response clears the stored tokens so the UI can surface "Reauthorize";
// transient failures keep them for the next attempt. Returns the new access
// token, null on failure, 'revoked' when the stored tokens were cleared.
async function refreshStoredTokens(row: HttpMcpServerRow, cfg: OauthConfig): Promise<string | null | 'revoked'> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.refresh_token as string,
    client_id: cfg.client_id,
  });
  if (cfg.client_secret) params.set('client_secret', cfg.client_secret);
  if (/^https?:\/\//i.test(row.url)) params.set('resource', row.url);
  const body = await tokenPost(cfg.token_url, params, `refresh for ${row.name}`);
  if (body === null) return null;
  if (body.__httpOk === false) {
    const status = body.__httpError as number;
    const text = String(body.__body ?? '');
    if ((status === 400 || status === 401) && /invalid_grant|revoked|expired/i.test(text)) {
      storeOauthBlock(row, { access_token: undefined, refresh_token: undefined, expires_at: undefined, reauth: true });
      console.warn(`[proxy] OAuth refresh rejected for ${row.name} (${status}) — tokens cleared, reauthorization required`);
      return 'revoked';
    }
    return null;
  }
  const access = saveGrantedTokens(row, body, 3600_000);
  if (access) {
    oauthTokens.set(row.name, { token: access, expiresAt: Date.now() + 3600_000 });
    console.log(`[proxy] OAuth2 token silently refreshed for ${row.name}`);
  }
  return access;
}

async function getOauthBearerToken(row: HttpMcpServerRow): Promise<string | null> {
  const cfg = parseOauthConfig(row.headers, row.authType);
  if (!cfg) return null;

  // (1) Stored authorization-code token still fresh → use it (persisted in
  // the DB, so it survives backend restarts — the in-memory map below is
  // only the client-credentials cache).
  if (cfg.access_token && typeof cfg.expires_at === 'number' && cfg.expires_at > Date.now() + 30_000) {
    return cfg.access_token;
  }
  // (2) Stored token present but stale → silent refresh before any fallback.
  if (cfg.access_token || cfg.refresh_token) {
    const refreshed = await refreshStoredTokens(row, cfg);
    if (refreshed === 'revoked') {
      // stored tokens cleared; fall through to client-credentials
    } else if (refreshed) {
      return refreshed;
    } else {
      // refresh endpoint transiently unreachable — do not break the request
      // on a flaky network; fall through to client-credentials if possible.
    }
  }

  // (3) Client-credentials grant (legacy/manual configs; last resort for
  // auth-code configs whose refresh token was revoked server-side).
  if (!cfg.client_secret) return null;
  const cached = oauthTokens.get(row.name);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
  });
  if (/^https?:\/\//i.test(row.url)) params.set('resource', row.url);
  const body = await tokenPost(cfg.token_url, params, `client-credentials for ${row.name}`);
  if (body === null || body.__httpOk === false) return null;
  const access = typeof body.access_token === 'string' ? body.access_token : null;
  if (!access) return null;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in * 1000 : 3600_000;
  oauthTokens.set(row.name, { token: access, expiresAt: Date.now() + expiresIn });
  console.log(`[proxy] OAuth2 client-credentials token acquired for ${row.name} (expires in ${Math.round(expiresIn / 1000)}s)`);
  return access;
}

// ── OAuth authorization-code exchange (backend half of the flow) ─────────
// The Electron main process runs the browser + loopback half (see
// electron/oauth-flow.js); the actual token exchange must happen HERE
// because the client_secret lives in the DB and never crosses the API or
// IPC. `code` + `redirect_uri` + `code_verifier` (PKCE, generated by the
// main process at flow start) are exchanged for tokens which are stored into
// the __oauth block.
export async function exchangeOauthCode(
  row: HttpMcpServerRow,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = parseOauthConfig(row.headers, row.authType);
  if (!cfg) return { ok: false, error: 'OAuth is not configured for this connector' };
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.client_id,
    code_verifier: codeVerifier,
  });
  if (cfg.client_secret) params.set('client_secret', cfg.client_secret);
  if (/^https?:\/\//i.test(row.url)) params.set('resource', row.url);
  const body = await tokenPost(cfg.token_url, params, `code exchange for ${row.name}`);
  if (body === null) return { ok: false, error: 'Token exchange failed (provider unreachable or timed out)' };
  if (body.__httpOk === false) {
    return { ok: false, error: `Token exchange failed: HTTP ${String(body.__httpError)} — ${String(body.__body ?? '').slice(0, 200)}` };
  }
  const access = typeof body.access_token === 'string' ? body.access_token : null;
  if (!access) return { ok: false, error: 'Provider returned no access_token' };
  saveGrantedTokens(row, body, 3600_000);
  console.log(`[proxy] OAuth2 authorization-code flow completed for ${row.name}`);
  return { ok: true };
}

// ── OAuth discovery (MCP spec: RFC 9728 → RFC 8414) ───────────────────────
// MCP servers MUST publish protected-resource metadata (RFC 9728) pointing
// at their authorization server(s); the AS MUST publish RFC 8414 metadata
// (or OIDC discovery). Probe in the spec's priority order, validate the
// issuer matches the well-known URL host, and return the endpoints the
// connector form can auto-populate.
export async function discoverOauthEndpoints(serverUrl: string): Promise<
  | { ok: true; authorization_url: string; token_url: string; scope?: string; issuer: string; registration_endpoint?: string }
  | { ok: false; error: string }
> {
  const base = new URL(serverUrl);
  if (!/^https?:\/\//i.test(serverUrl)) return { ok: false, error: 'Server URL must be http(s)' };
  const host = base.origin;

  const probe = async (url: string): Promise<Record<string, unknown> | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      if (!res.ok) { await res.arrayBuffer().catch(() => {}); return null; }
      const j = (await res.json()) as Record<string, unknown>;
      return j;
    } catch { return null; } finally { clearTimeout(timer); }
  };

  // Spec order: if the MCP endpoint itself answers 401 with a
  // WWW-Authenticate resource_metadata directive (RFC 9728 §5), that URL is
  // authoritative and wins over the well-known construction.
  const metadataFromChallenge = await (async (): Promise<Record<string, unknown> | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(serverUrl, { method: 'GET', signal: controller.signal });
      await res.arrayBuffer().catch(() => {});
      const challenge = res.headers.get('www-authenticate') ?? '';
      const m = /resource_metadata="([^"]+)"/.exec(challenge);
      if (!m) return null;
      return probe(m[1]);
    } catch { return null; } finally { clearTimeout(timer); }
  })();
  if (metadataFromChallenge) {
    const authServers = metadataFromChallenge.authorization_servers;
    if (!Array.isArray(authServers) || authServers.length === 0 || typeof authServers[0] !== 'string') {
      return { ok: false, error: 'Protected-resource metadata has no authorization_servers' };
    }
    const scopeHint = Array.isArray(metadataFromChallenge.scopes_supported) ? (metadataFromChallenge.scopes_supported as string[])[0] : undefined;
    return finishDiscovery(authServers[0] as string, scopeHint, probe);
  }

  // Step 1: protected-resource metadata (RFC 9728). Path-first (spec order):
  // <host>/.well-known/oauth-protected-resource/<path> then the root form.
  const pathInserted = `${host}/.well-known/oauth-protected-resource${base.pathname.replace(/\/+$/, '')}`;
  let prm = await probe(pathInserted);
  if (!prm) prm = await probe(`${host}/.well-known/oauth-protected-resource`);
  if (!prm) return { ok: false, error: 'No protected-resource metadata at this MCP endpoint (RFC 9728)' };
  const authServers = prm.authorization_servers;
  if (!Array.isArray(authServers) || authServers.length === 0 || typeof authServers[0] !== 'string') {
    return { ok: false, error: 'Protected-resource metadata has no authorization_servers' };
  }
  const scopeHint = Array.isArray(prm.scopes_supported) ? (prm.scopes_supported as string[])[0] : undefined;
  return finishDiscovery(authServers[0] as string, scopeHint, probe);
}

// Step 2 of the discovery chain: RFC 8414 (or OIDC) metadata on the issuer.
async function finishDiscovery(
  issuer: string,
  scopeHint: string | undefined,
  probe: (url: string) => Promise<Record<string, unknown> | null>,
): Promise<
  | { ok: true; authorization_url: string; token_url: string; scope?: string; issuer: string; registration_endpoint?: string }
  | { ok: false; error: string }
> {
  let asm: Record<string, unknown> | null = null;
  try {
    const asBase = new URL(issuer);
    const asHost = asBase.origin;
    const asPath = asBase.pathname.replace(/\/+$/, '');
    // RFC 8414 priority order (path-insertion for path-issuers, then OIDC).
    const candidates = [
      `${asHost}/.well-known/oauth-authorization-server${asPath}`,
      `${asHost}/.well-known/openid-configuration${asPath}`,
      `${asHost}${asPath}/.well-known/openid-configuration`,
      `${asHost}/.well-known/oauth-authorization-server`,
      `${asHost}/.well-known/openid-configuration`,
    ];
    for (const c of candidates) {
      asm = await probe(c);
      if (asm) break;
    }
  } catch { /* invalid issuer URL */ }
  if (!asm) return { ok: false, error: `No authorization-server metadata for issuer ${issuer} (RFC 8414)` };
  const authEndpoint = typeof asm.authorization_endpoint === 'string' ? asm.authorization_endpoint : null;
  const tokenEndpoint = typeof asm.token_endpoint === 'string' ? asm.token_endpoint : null;
  if (!authEndpoint || !tokenEndpoint) {
    return { ok: false, error: 'Authorization-server metadata lacks authorization_endpoint/token_endpoint' };
  }
  const scopes = Array.isArray(asm.scopes_supported) ? (asm.scopes_supported as string[])[0] : scopeHint;
  return {
    ok: true,
    authorization_url: authEndpoint,
    token_url: tokenEndpoint,
    issuer,
    scope: scopes,
    registration_endpoint: typeof asm.registration_endpoint === 'string' ? asm.registration_endpoint : undefined,
  };
}

// ── One-click Connect plumbing (RFC 7591 dynamic client registration) ─────
// The "Sign in with Google"-grade flow: a fresh OAuth connector knows only
// its URL. On first Connect the backend discovers the provider's endpoints
// (RFC 9728 → 8414) and, if the provider supports it, registers this desktop
// client dynamically (RFC 7591) so a client_id exists without the user
// typing anything. Providers without a registration endpoint fall back to
// the stored/manual config — the endpoint then says so in plain words.
export async function registerOauthClient(
  row: HttpMcpServerRow,
  redirectUri: string,
): Promise<
  | { ok: true; config: { authorization_url?: string; token_url: string; client_id: string; scope?: string; use_pkce: boolean } }
  | { ok: false; error: string }
> {
  // A fresh connector may have no __oauth block yet (auth_type oauth2 set at
  // registration, nothing else) — that is the exact one-click case: discover
  // + register from the URL alone.
  const cfg = parseOauthConfig(row.headers, row.authType);
  if (!cfg && row.authType !== 'oauth2') return { ok: false, error: 'OAuth2 is not configured for this connector' };
  const known: OauthConfig = cfg ?? { token_url: '', client_id: '', use_pkce: true };

  let endpoints: Awaited<ReturnType<typeof discoverOauthEndpoints>> | null = null;
  let registrationEndpoint: string | undefined;
  let scope = known.scope;
  if (!known.authorization_url || !known.token_url) {
    if (!/^https?:\/\//i.test(row.url)) return { ok: false, error: 'Server has no endpoint URL to discover from' };
    const disc = await discoverOauthEndpoints(row.url);
    if (!disc.ok) return disc;
    endpoints = disc;
    registrationEndpoint = disc.registration_endpoint;
    scope = disc.scope ?? known.scope;
  }

  let clientId = known.client_id;
  let clientSecret = known.client_secret;
  if (!clientId) {
    if (!registrationEndpoint) {
      return {
        ok: false,
        error:
          'This provider does not support automatic registration — add its OAuth endpoints and client ID in connector settings.',
      };
    }
    const body = JSON.stringify({
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      client_name: 'Context Fence',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let reg: Response;
    try {
      reg = await fetch(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const name = (err as Error).name;
      return { ok: false, error: name === 'AbortError' ? 'Provider registration timed out — try again.' : 'Provider registration failed — try again.' };
    } finally {
      clearTimeout(timer);
    }
    const regText = await reg.text().catch(() => '');
    if (!reg.ok) {
      return { ok: false, error: `Provider registration failed (HTTP ${reg.status}) — check connector settings.` };
    }
    let regBody: { client_id?: unknown; client_secret?: unknown };
    try { regBody = JSON.parse(regText); } catch { return { ok: false, error: 'Provider registration returned no client ID.' }; }
    if (typeof regBody.client_id !== 'string' || !regBody.client_id) {
      return { ok: false, error: 'Provider registration returned no client ID.' };
    }
    clientId = regBody.client_id;
    if (typeof regBody.client_secret === 'string' && regBody.client_secret) clientSecret = regBody.client_secret;
  }

  // Persist whatever we learned (endpoints, registered client) — the next
  // Connect click (or refresh) uses it without re-registering.
  const patch: Partial<OauthConfig> = { client_id: clientId };
  if (clientSecret) patch.client_secret = clientSecret;
  if (endpoints) {
    patch.authorization_url = endpoints.authorization_url;
    patch.token_url = endpoints.token_url;
    if (endpoints.scope) patch.scope = endpoints.scope;
  }
  storeOauthBlock(row, patch);
  console.log(`[proxy] OAuth client ${clientId} ready for ${row.name} (redirect ${redirectUri})`);
  return {
    ok: true,
    config: {
      authorization_url: known.authorization_url ?? patch.authorization_url,
      token_url: known.token_url ?? patch.token_url ?? '',
      client_id: clientId,
      scope,
      use_pkce: true,
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function jsonRpcErrorBody(id: number | string | null | undefined, message: string): string {
  return JSON.stringify(synthesizeError(id, message));
}

/**
 * Forward one inbound JSON-RPC message to the real HTTP endpoint and relay
 * the upstream response (status + headers + body) back to the caller. Auth:
 * the client's own Authorization header wins; otherwise the Authorization
 * stored on the server row at protect-time is injected. Upstream responses
 * are passed through untouched (plain JSON or SSE both work).
 */
async function forwardHttp(
  row: HttpMcpServerRow,
  wire: JsonRpcMessage,
  clientAuth: string | null,
  accept: string | null,
  ctx: RequestContext,
  respond: (status: number, headers: Record<string, string>, body: Buffer) => void,
): Promise<void> {
  // Self-loop guard: a row whose url points at the proxy's own HTTP ingress
  // (http://127.0.0.1:3002/<name>) would make us fetch ourselves forever —
  // fail fast with a hard error instead of an endless "fetch failed" loop.
  // healSelfLoopRows() repairs such rows from the agent backup config.
  if (row.url && isProxyIngressUrl(row.url)) {
    const msg = `Self-loop detected: ${row.name} is configured to fetch Context Fence's own ingress (${row.url}). Re-import this MCP from the agent config (Sync agent) to heal.`;
    writeFailureAudit(ctx, row.name, `Self-loop: ${msg}`, 0);
    respond(502, { 'Content-Type': 'application/json' }, Buffer.from(jsonRpcErrorBody(wire.id, msg)));
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (accept) headers['Accept'] = accept;
  if (clientAuth) headers['Authorization'] = clientAuth;
  else {
    // OAuth2 connectors get a proxy-minted bearer token (client-credentials
    // grant against the stored token_url, cached until expiry); everything
    // else uses the static headers stored at protect/import time.
    const oauthToken = await getOauthBearerToken(row);
    const stored = parseStoredHeaders(row.headers);
    if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;
    else if (stored.Authorization) headers['Authorization'] = stored.Authorization;
    else {
      for (const [k, v] of Object.entries(stored)) {
        if (k !== '__oauth') headers[k] = v;
      }
    }
  }

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let upstream: Response;
  try {
    upstream = await fetch(row.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(wire),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    writeFailureAudit(ctx, row.name, `HTTP forward failed: ${(err as Error).message}`, Date.now() - t0);
    respond(502, { 'Content-Type': 'application/json' }, Buffer.from(jsonRpcErrorBody(wire.id, `Upstream MCP server unreachable: ${(err as Error).message}`)));
    return;
  }
  clearTimeout(timer);

  const responseHeaders: Record<string, string> = {};
  const contentType = upstream.headers.get('content-type');
  if (contentType) responseHeaders['Content-Type'] = contentType;
  const sessionId = upstream.headers.get('mcp-session-id');
  if (sessionId) responseHeaders['Mcp-Session-Id'] = sessionId;

  const body = Buffer.from(await upstream.arrayBuffer());
  respond(upstream.status, responseHeaders, body);
}

function waitForReady(server: SpawnedServer, timeoutMs = 10000): Promise<void> {
  if (server.ready) return Promise.resolve();
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (server.ready || Date.now() >= deadline) {
        clearInterval(tick);
        resolve();
      }
    }, 50);
  });
}

/**
 * Stdio tie-in for the HTTP ingress: relays a proxied stdio server (e.g.
 * Playwright MCP) to real HTTP clients posting to /<server-name>. The child
 * is spawned + initialized by the proxy, so a client `initialize` is answered
 * from the child's stored handshake result (double-initializing the child is
 * not safe); everything else runs the same evaluate → forward/deny path as
 * the TCP/HTTP wire against the child's stdio transport.
 */
async function handleStdioBridgeRequest(
  res: ServerResponse,
  wire: JsonRpcMessage,
  ctx: RequestContext,
  serverName: string,
  sse: SseChannel | null,
): Promise<void> {
  let server = servers.get(serverName);
  if (!server || !server.child.stdin || server.child.stdin.destroyed) {
    const sp = spawnRegisteredServer(serverName);
    if (!sp.ok) {
      deliverJsonRpc(res, sse, synthesizeError(wire.id, `Cannot launch MCP server "${serverName}": ${sp.error ?? 'unknown error'}`));
      return;
    }
    server = servers.get(serverName);
  }
  if (!server) {
    deliverJsonRpc(res, sse, synthesizeError(wire.id, `MCP server "${serverName}" is not running`));
    return;
  }

  // Client initialize: the child already completed its handshake with the
  // proxy. Answer from the stored result (still policy-evaluated + audited).
  if (wire.method === 'initialize') {
    const t0 = Date.now();
    const result = isFirewallEnabled()
      ? evaluatePolicy(ctx, serverName, () => evaluateRequest(ctx.method, ctx.params, serverName, ctx.sessionKey))
      : { decision: 'allow' as const, reason: 'firewall disabled' };
    if (result.decision === 'deny') {
      if (ctx.id !== null) deliverJsonRpc(res, sse, buildDenyError(ctx.id, result.reason));
      else { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(); }
      writeAudit(ctx, serverName, 'deny', result.reason, Date.now() - t0);
      fireDenyWebhook(ctx, serverName, 'deny', result.reason, Date.now() - t0);
      return;
    }
    if (ctx.id === null) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end();
      return;
    }
    // If the child was just spawned (first request), wait for its real
    // handshake so the synthesized result carries the true capabilities.
    if (!server.ready || server.initResult === undefined) await waitForReady(server);
    const initResult = server.initResult ?? {
      protocolVersion: '2025-03-26',
      capabilities: {},
      serverInfo: { name: serverName, version: '1.0.0' },
    };
    writeAudit(ctx, serverName, result.decision, result.reason, Date.now() - t0);
    deliverJsonRpc(res, sse, { jsonrpc: '2.0', id: wire.id, result: initResult });
    return;
  }

  // Notification: no response expected — evaluate, forward, audit, 202.
  if (ctx.id === null) {
    const t0 = Date.now();
    const result = isFirewallEnabled()
      ? evaluatePolicy(ctx, serverName, () => evaluateRequest(ctx.method, ctx.params, serverName, ctx.sessionKey))
      : { decision: 'allow' as const, reason: 'firewall disabled' };
    if (result.decision === 'deny') {
      writeAudit(ctx, serverName, 'deny', result.reason, Date.now() - t0);
      fireDenyWebhook(ctx, serverName, 'deny', result.reason, Date.now() - t0);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end();
      return;
    }
    forwardToChildWhenReady(server, { jsonrpc: '2.0', method: ctx.method, params: ctx.params })
      .then(() => writeAudit(ctx, serverName, result.decision, result.reason, Date.now() - t0))
      .catch((err: Error) => {
        writeFailureAudit(ctx, serverName, `Forward failed: ${err.message}`, Date.now() - t0);
      });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end();
    return;
  }

  // Request: the full evaluate → forward/deny path, response relayed to the
  // client (over SSE when an SSE channel is active, inline JSON otherwise).
  decideAndForward(ctx, server, (msg) => {
    deliverJsonRpc(res, sse, msg);
  });
}

/**
 * One HTTP MCP request: policy-evaluate, then deny in-band or forward.
 * Mirrors decideAndForward (TCP) semantics, including the firewall-disabled
 * bypass which is audited as allow / 'firewall disabled'.
 */
async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  serverName: string,
  sse: SseChannel | null,
): Promise<void> {
  const httpRow = getHttpServer(serverName);
  const stdioRow = getStdioServer(serverName);
  if (!httpRow && !stdioRow) {
    writeJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: `No MCP server registered as "${serverName}"` } });
    return;
  }

  const rawBody = await readBody(req);
  let wire: JsonRpcMessage;
  try {
    wire = JSON.parse(rawBody) as JsonRpcMessage;
  } catch {
    writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } });
    return;
  }
  if (!wire || typeof wire.method !== 'string') {
    writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: missing method' } });
    return;
  }

  const remoteKey = `${req.socket.remoteAddress ?? 'unknown'}|${serverName}`;
  if (wire.method === 'initialize') {
    const info = (wire.params as { clientInfo?: { name?: unknown } } | null)?.clientInfo;
    if (info && typeof info.name === 'string' && info.name.trim()) {
      httpClientIdentities.set(remoteKey, info.name.trim());
    }
  }

  const ctx: RequestContext = {
    agent: httpClientIdentities.get(remoteKey) ?? `http:${req.socket.remoteAddress ?? 'unknown'}`,
    id: wire.id === undefined ? null : wire.id,
    method: wire.method,
    params: wire.params,
    raw: rawBody,
    sessionKey: remoteKey,
  };

  // Stdio server: bridge the call onto the spawned child instead of an HTTP
  // upstream (identity/ctx captured above are shared).
  if (stdioRow) {
    await handleStdioBridgeRequest(res, wire, ctx, stdioRow.name, sse);
    return;
  }
  if (!httpRow) {
    writeJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: `No MCP server registered as "${serverName}"` } });
    return;
  }

  const clientAuth = req.headers.authorization ?? null;
  const accept = req.headers.accept ?? null;
  const respond = (status: number, headers: Record<string, string>, body: Buffer): void => {
    if (!res.writableEnded) {
      res.writeHead(status, headers);
      res.end(body);
    }
  };
  // SSE mode: upstream's single JSON-RPC response is pushed on the stream
  // (202 in-band) instead of relayed inline; SSE bodies pass through as-is.
  const relayRespond = sse
    ? (status: number, headers: Record<string, string>, body: Buffer): void => {
        const text = body.toString('utf-8').trim();
        try {
          if (text.startsWith('{') || text.startsWith('[')) {
            deliverJsonRpc(res, sse, JSON.parse(text) as JsonRpcMessage);
            return;
          }
        } catch { /* non-JSON-RPC JSON — push raw as an event */ }
        if (!res.writableEnded) {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end();
        }
        if (sse && !sse.res.writableEnded) sse.res.write(`event: message\ndata: ${text}\n\n`);
      }
    : respond;

  if (!isFirewallEnabled()) {
    const t0 = Date.now();
    await forwardHttp(httpRow, wire, clientAuth, accept, ctx, (status, headers, body) => {
      writeAudit(ctx, httpRow.name, 'allow', 'firewall disabled', Date.now() - t0);
      relayRespond(status, headers, body);
    });
    return;
  }

  const result = evaluatePolicy(ctx, httpRow.name, () => evaluateRequest(ctx.method, ctx.params, httpRow.name, ctx.sessionKey));
  const t0 = Date.now();

  if (result.decision === 'deny') {
    if (ctx.id !== null) {
      deliverJsonRpc(res, sse, buildDenyError(ctx.id, result.reason));
    } else {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end();
    }
    writeAudit(ctx, httpRow.name, 'deny', result.reason, Date.now() - t0);
    fireDenyWebhook(ctx, httpRow.name, 'deny', result.reason, Date.now() - t0);
    return;
  }

  // allow | log — forward, then audit (decision recorded even if the
  // upstream errored; the reason reflects what actually happened).
  await forwardHttp(httpRow, wire, clientAuth, accept, ctx, (status, headers, body) => {
    scanResponseForEnv(ctx, httpRow.name, body);
    let reason = result.reason;
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      if (parsed?.error?.message) reason = parsed.error.message;
    } catch { /* non-JSON body (SSE stream etc.) — keep rule reason */ }
    writeAudit(ctx, httpRow.name, result.decision, reason, Date.now() - t0);
    relayRespond(status, headers, body);
  });
}

/**
 * Start the HTTP MCP ingress (127.0.0.1:3002). Only POST /<server-name> is
 * meaningful: GET/DELETE (streamable-HTTP session management) return 405 —
 * the upstream servers this ingress relays to (e.g. synthrun) are stateless
 * JSON endpoints, and anonymous relays of long-lived SSE sessions would
 * create uncloseable agent-to-proxy connections.
 */
export function startHttpIngress(): Promise<void> {
  const server = createHttpServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      const serverName = path.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!serverName || serverName.includes('/')) {
        writeJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid MCP server path' } });
        return;
      }
      const remoteKey = `${req.socket.remoteAddress ?? 'unknown'}|${serverName}`;

      // Legacy HTTP+SSE stream: opencode's `type: remote` runtime GETs the
      // endpoint to open an SSE stream and fails on anything but 200 + SSE
      // ("SSE error: Non-200 status code (405)"). Serve the stream with an
      // `endpoint` event; responses to that client's POSTs arrive as
      // `message` events (see handleHttpRequest / deliverJsonRpc).
      if (req.method === 'GET') {
        if (!getHttpServer(serverName) && !getStdioServer(serverName)) {
          writeJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: `No MCP server registered as "${serverName}"` } });
          return;
        }
        openSseChannel(remoteKey, serverName, res);
        return;
      }

      if (req.method !== 'POST') {
        writeJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Method ${req.method} not allowed on MCP HTTP ingress (GET for SSE or POST only)` } });
        return;
      }

      const sse = getSseChannel(remoteKey, serverName);
      await handleHttpRequest(req, res, serverName, sse);
    } catch (err) {
      if (!res.writableEnded) {
        writeJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: (err as Error).message } });
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PROXY_HTTP_PORT, '127.0.0.1', () => {
      console.log(`[proxy] HTTP MCP ingress listening on port ${PROXY_HTTP_PORT}`);
      resolve();
    });
  });
}
