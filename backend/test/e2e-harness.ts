// End-to-end test harness for the MCP firewall.
//
// Starts the REAL backend + proxy (src/index.ts) as a child process against a
// throwaway SQLite file (CF_DATA_DIR -> temp dir), registers fake MCP servers
// backed by echo-server.js child processes, and exposes sendRequest() which
// talks to the proxy over real TCP (127.0.0.1:proxyPort) with Content-Length
// JSON-RPC framing — the same path a real MCP client would take.
//
// Usage:
//   npx tsx test/e2e-harness.ts            # self-check (N1): one benign request
//   npx tsx test/e2e-harness.ts <port>     # expose ports for other scripts? no: import only

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = join(__dirname, '..');

// Must be set before importing db so the module binds to the temp file.
export const dataDir = mkdtempSync(join(tmpdir(), 'cf-harness-'));
process.env.CF_DATA_DIR = dataDir;

const { default: db } = await import('../src/db/index.js');

let moduleIdCounter = 1000;

export interface AuditRow {
  id: string;
  agent: string;
  tool: string;
  method: string;
  decision: string;
  reason: string | null;
  duration_ms: number;
  session_id: string | null;
  params: string | null;
}

export interface HarnessResponse {
  ok: boolean;
  decision: 'allow' | 'deny' | 'log';
  error?: string;
  result?: unknown;
  durationMs: number;
  sessionId: string;
}

export interface Harness {
  sendRequest(
    serverName: string,
    method: string,
    params: unknown,
    opts?: { id?: string; timeoutMs?: number },
  ): Promise<HarnessResponse>;
  httpSendRequest(serverName: string, method: string, params: unknown): Promise<HarnessResponse>;
  sendRaw(body: unknown, settleMs?: number): Promise<{ messages: unknown[]; auditCount: number }>;
  auditLog(): AuditRow[];
  countAudit(): number;
  resetAudit(): void;
  stop(): void;
  httpPort: number;
  proxyPort: number;
  httpIngressPort: number;
  dataDir: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function frame(msg: unknown): Buffer {
  const body = JSON.stringify(msg);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`);
}

export async function startHarness(opts?: {
  policyDir?: string;
  servers?: { name: string; command: string; args: string[] }[];
  real?: boolean;
}): Promise<Harness> {
  const httpPort = await freePort();
  const proxyPort = await freePort();
  const httpIngressPort = await freePort();

  if (opts?.real) {
    // Register real servers through the product's own detection flow: a
    // project-level backend/.mcp.json -> getMcpServersFromConfigs() upsert.
    // Same code path as POST /api/detect/scan; runs here in the parent so the
    // rows exist before the child boots (startProxy spawns at boot).
    const { getMcpServersFromConfigs } = await import('../src/agent-det/detector.js');
    getMcpServersFromConfigs();
  } else {
    const servers = opts?.servers ?? [
      { name: 'echo-a', command: 'node', args: ['test/echo-server.js'] },
      { name: 'echo-b', command: 'node', args: ['test/echo-server.js'] },
    ];
    const insert = db.prepare(
      'INSERT OR REPLACE INTO mcp_servers (name, type, url, command, args, env, connected) VALUES (?, ?, NULL, ?, ?, NULL, 1)',
    );
    for (const s of servers) insert.run(s.name, 'stdio', s.command, JSON.stringify(s.args));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CF_DATA_DIR: dataDir,
    CF_PROXY_PORT: String(proxyPort),
    CF_PROXY_HTTP_PORT: String(httpIngressPort),
    PORT: String(httpPort),
  };
  if (opts?.policyDir) {
    mkdirSync(opts.policyDir, { recursive: true });
    env.CF_POLICY_DIR = opts.policyDir;
  }

  const tsxBin = join(BACKEND_DIR, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxBin, ['src/index.ts'], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let stderrBuf = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderrBuf += d.toString();
    if (process.env.CF_HARNESS_VERBOSE) process.stderr.write(`[child] ${d.toString()}`);
  });

  // Wait for readiness.
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Backend child exited early (code=${child.exitCode}):\n${stderrBuf}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`Backend failed to start within 15s:\n${stderrBuf}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  let nextId = 1000;

  function sendRequest(
    serverName: string,
    method: string,
    params: unknown,
    requestOpts?: { id?: string; timeoutMs?: number },
  ): Promise<HarnessResponse> {
    // Process-global counter so ids never collide across harness instances
    // sharing one temp DB.
    const id = requestOpts?.id ?? String(moduleIdCounter++);
    const timeoutMs = requestOpts?.timeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      const sock = net.connect(proxyPort, '127.0.0.1');
      let buf = Buffer.alloc(0);
      const messages: { msg: unknown }[] = [];
      let done = false;

      const finish = async (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.end();
        if (err) return reject(err);
        // The proxy writes the audit row slightly after forwarding the
        // response — poll briefly for it so callers read committed state.
        let audit: AuditRow | undefined;
        for (let i = 0; i < 25; i++) {
          audit = auditLog().find((r) => r.session_id === id);
          if (audit) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const reply = messages.find(
          (m) => (m.msg as { id?: unknown }).id !== undefined && String((m.msg as { id?: unknown }).id) === id,
        )?.msg as { error?: { message?: string }; result?: unknown } | undefined;
        const decision = audit?.decision ?? (reply?.error ? 'deny' : 'log');
        resolve({
          ok: !!audit && !reply?.error,
          decision: decision as 'allow' | 'deny' | 'log',
          error: audit?.reason ?? reply?.error?.message,
          result: reply?.result,
          durationMs: audit?.duration_ms ?? -1,
          sessionId: id,
        });
      };

      const timer = setTimeout(() => finish(new Error(`timeout waiting for response (id=${id})`)), timeoutMs);

      sock.on('connect', () => sock.write(frame({ jsonrpc: '2.0', id, method, params })));
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const headerEnd = buf.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;
          const m = /content-length\s*:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString());
          if (!m) return;
          const len = parseInt(m[1], 10);
          const start = headerEnd + 4;
          if (buf.length < start + len) return;
          messages.push({ msg: JSON.parse(buf.subarray(start, start + len).toString()) });
          buf = buf.subarray(start + len);
          const last = messages[messages.length - 1].msg as { id?: unknown };
          if (last.id !== undefined && String(last.id) === id) finish();
        }
      });
      sock.on('error', (e) => finish(e));
      sock.on('close', () => finish(new Error(`connection closed before response (id=${id})`)));
    });
  }

  function auditLog(): AuditRow[] {
    return db
      .prepare(
        'SELECT id, agent, tool, method, decision, reason, duration_ms, session_id, params FROM audit_log ORDER BY rowid DESC',
      )
      .all() as AuditRow[];
  }

  function countAudit(): number {
    return (db.prepare('SELECT COUNT(*) as n FROM audit_log').get() as { n: number }).n;
  }

  function resetAudit(): void {
    db.prepare('DELETE FROM audit_log').run();
  }

  /** Per-server routing through the proxy's sendRequest path (POST /api/test-mcp).
   *  TCP ingress can't pick a server (proxy forwards to the first spawned
   *  child), so per-server tests go over HTTP. */
  async function httpSendRequest(serverName: string, method: string, params: unknown): Promise<HarnessResponse> {
    const resp = await fetch(`http://127.0.0.1:${httpPort}/api/test-mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: serverName, method, params }),
    });
    const body = (await resp.json()) as {
      ok: boolean;
      result?: {
        decision: string;
        response?: unknown;
        error?: string | null;
        durationMs: number;
      };
      error?: string;
    };
    if (!body.ok && body.result?.error) {
      return {
        ok: false,
        decision: (body.result.decision as 'allow' | 'deny' | 'log') ?? 'deny',
        error: body.result.error,
        durationMs: body.result.durationMs,
        sessionId: String(moduleIdCounter++),
      };
    }
    if (!body.result) {
      return {
        ok: false,
        decision: 'deny',
        error: body.error ?? 'unknown error',
        durationMs: 0,
        sessionId: String(moduleIdCounter++),
      };
    }
    // The proxy writes allow-path audit rows just after forwarding the
    // response — poll briefly for the new row (rowid DESC, newest first).
    const before = countAudit();
    for (let i = 0; i < 25; i++) {
      if (countAudit() > before) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const ownRow = auditLog().find((r) => r.agent === `api:${serverName}`);
    return {
      ok: body.ok && !body.result.error,
      decision: body.result.decision as 'allow' | 'deny' | 'log',
      result: body.result.response,
      error: body.result.error ?? undefined,
      durationMs: body.result.durationMs,
      sessionId: ownRow?.session_id ?? String(moduleIdCounter++),
    };
  }

  async function sendRaw(body: unknown, settleMs = 400): Promise<{ messages: unknown[]; auditCount: number }> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(proxyPort, '127.0.0.1');
      const messages: unknown[] = [];
      let buf = Buffer.alloc(0);
      sock.on('connect', () => sock.write(frame(body)));
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const headerEnd = buf.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;
          const m = /content-length\s*:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString());
          if (!m) return;
          const len = parseInt(m[1], 10);
          const start = headerEnd + 4;
          if (buf.length < start + len) return;
          messages.push(JSON.parse(buf.subarray(start, start + len).toString()));
          buf = buf.subarray(start + len);
        }
      });
      sock.on('error', reject);
      setTimeout(() => {
        sock.end();
        resolve({ messages, auditCount: countAudit() });
      }, settleMs);
    });
  }

  return {
    sendRequest,
    httpSendRequest,
    sendRaw,
    auditLog,
    countAudit,
    resetAudit,
    httpPort,
    proxyPort,
    httpIngressPort,
    dataDir,
    stop() {
      // Kill the backend's whole process group (backend -> npx -> server ->
      // chromium): SIGTERM, then SIGKILL the group if it survives 3s.
      const pid = child.pid;
      try {
        process.kill(-pid!, 'SIGTERM');
      } catch { /* already gone */ }
      const deadline = Date.now() + 3000;
      const poll = setInterval(() => {
        if (child.exitCode !== null || Date.now() > deadline) {
          clearInterval(poll);
          if (child.exitCode === null && pid) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch { /* already gone */ }
          }
        }
      }, 100);
    },
  };
}

/** Remove the harness temp data dir (call after all harness instances are done). */
export function cleanupTemp(): void {
  rmSync(dataDir, { recursive: true, force: true });
}

// ── N1 self-check: run the harness directly with one benign request ──
async function main() {
  const h = await startHarness();
  try {
    console.log(`[harness] backend up on :${h.httpPort}, proxy on :${h.proxyPort}`);
    console.log(`[harness] temp data dir: ${h.dataDir}`);
    const res = await h.sendRequest('echo-a', 'tools/call', { name: 'say_hello', arguments: { text: 'harness-check' } });
    console.log('[harness] benign request response:', JSON.stringify(res, null, 2));
    const rows = h.auditLog().filter((r) => r.session_id === res.sessionId);
    console.log('[harness] matching audit_log row:', JSON.stringify(rows[0] ?? null, null, 2));
    if (res.ok && rows.length === 1 && rows[0].decision === 'allow') {
      console.log('[harness] N1 SELF-CHECK PASS — response received and audit row written');
      return true;
    }
    console.log('[harness] N1 SELF-CHECK FAIL');
    return false;
  } finally {
    h.stop();
    cleanupTemp();
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('e2e-harness.ts');
if (isMain) {
  main().then((pass) => process.exit(pass ? 0 : 1)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
