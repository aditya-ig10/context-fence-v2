import { Router } from 'express';
import db from '../db/index.js';
import {
  testMcpConnection,
  spawnRegisteredServer,
  stopServer,
  getRegisteredServers,
  discoverTools,
  parseOauthBlock,
  exchangeOauthCode,
  discoverOauthEndpoints,
  registerOauthClient,
  PROXY_HTTP_PORT,
  type RegisteredServerStatus,
} from '../mcp/proxy.js';
import { broadcast } from '../realtime/hub.js';
import { detectMcpConnectors, getConnectorConfigForImport, isProxyIngressUrl } from '../agent-det/detector.js';
import { protectAgent, unbindServerFromAgent, isProtected } from '../protect/rewriter.js';
import { AGENT_ADAPTERS } from '../agent-det/adapters/registry.js';

const router = Router();

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

// Secrets rule: env + header VALUES are never returned by any endpoint. The
// detail/list shapes carry only key names, presence flags, and auth type.
function enrichServer(r: RegisteredServerStatus) {
  const storedRow = db
    .prepare('SELECT headers, auth_type FROM mcp_servers WHERE name = ?')
    .get(r.name) as { headers: string | null; auth_type: string } | undefined;
  const headers = parseStoredHeaders(storedRow?.headers ?? null);
  const authType = storedRow?.auth_type ?? 'none';
  const headerNames = Object.keys(headers).filter((k) => k !== '__oauth');
  const hasCredentials = headerNames.length > 0 || (headers.__oauth ? true : false);
  // OAuth auth-code status (secrets and tokens are NEVER returned — the
  // renderer only learns presence + expiry so it can offer Connect vs
  // Reauthorize vs nothing). `configured` means a browser flow can actually
  // run (authorization_url + token_url + client_id present).
  const oauthBlock = parseOauthBlock(storedRow?.headers ?? null);
  const oauth = {
    configured: !!(oauthBlock?.authorization_url && oauthBlock?.token_url && oauthBlock?.client_id),
    hasToken: !!oauthBlock?.access_token,
    hasRefreshToken: !!oauthBlock?.refresh_token,
    expiresAt: typeof oauthBlock?.expires_at === 'number' ? oauthBlock.expires_at : null,
    expired: typeof oauthBlock?.expires_at === 'number' ? Date.now() > oauthBlock.expires_at : false,
    reauth: oauthBlock?.reauth === true,
  };
  const toolCount = (db.prepare('SELECT COUNT(*) as n FROM discovered_tools WHERE server_name = ?').get(r.name) as { n: number }).n;
  const boundAgents = db
    .prepare('SELECT agent_type as agentType, enabled FROM agent_connectors WHERE server_name = ?')
    .all(r.name) as { agentType: string; enabled: number }[];
  const callsToday = (db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE server = ? AND timestamp >= datetime('now', 'localtime', 'start of day', 'utc')").get(r.name) as { n: number }).n;
  const lastSync = (db.prepare('SELECT MAX(last_synced_at) as at FROM discovered_tools WHERE server_name = ?').get(r.name) as { at: string | null }).at;
  // HTTP connectors are not spawned children — their liveness is the last
  // sync outcome (connected=1 written on a successful tools/list). OAuth2
  // connectors that have never completed a browser flow (or whose stored
  // token is gone) report needs-auth so the UI offers Connect.
  let status = r.status;
  if (r.type === 'http') {
    if (authType === 'oauth2') {
      // needs-auth: never authorized, or authorization was lost (revoked)
      // and must be re-run — the UI renders "Connect" / "Reauthorize".
      status = oauth.reauth || (oauth.configured && !oauth.hasToken) ? 'needs-auth' : r.connected === 1 ? 'connected' : 'error';
    } else {
      status = r.connected === 1 ? 'connected' : authType !== 'none' && !hasCredentials ? 'needs-auth' : 'error';
    }
  }
  return {
    ...r,
    status,
    authType,
    oauth,
    headerNames,
    hasCredentials,
    toolCount,
    boundAgents,
    callsToday,
    lastSync,
  };
}

// Registered MCP servers with a live health status per row (connected /
// error / needs-auth from a real check, not a static dot). env values are
// NEVER returned — only key names and whether a value is present.
router.get('/', (_req, res) => {
  try {
    res.json({ servers: getRegisteredServers().map(enrichServer) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch servers' });
  }
});

// Test Connection — spawns the candidate config through the real proxy path
// (stdio transport + initialize handshake + ping) WITHOUT registering it.
router.post('/test', async (req, res) => {
  try {
    const { command, args, env } = req.body as {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    };
    if (!command || !command.trim()) {
      return res.status(400).json({ error: 'command required to test a stdio server' });
    }
    const result = await testMcpConnection({
      command: command.trim(),
      args: Array.isArray(args) ? args.map(String) : [],
      env: env && typeof env === 'object' ? env : {},
    });
    res.json({ ok: result.ok, error: result.error ?? null, handshakeMs: result.handshakeMs });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Test connection failed' });
  }
});

// Test Connection for a REGISTERED server (B4): spawns the stored stdio
// command through the real proxy transport and waits for a genuine JSON-RPC
// initialize response (5s), then a ping. HTTP rows are tested through the
// local ingress with the same initialize handshake. The card's "Test" action
// shows Connected / Timeout / Error — never a guessed status.
router.post('/:name/test', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const row = db.prepare('SELECT type, url, command, args, env FROM mcp_servers WHERE name = ?').get(name) as
      { type: string; url: string | null; command: string | null; args: string | null; env: string | null } | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });

    if (row.type === 'stdio') {
      if (!row.command) return res.status(400).json({ status: 'error', message: 'No launch command stored for this server' });
      let args: string[] = [];
      let env: Record<string, string> = {};
      try { args = row.args ? (JSON.parse(row.args) as string[]) : []; } catch { /* malformed stored args */ }
      try { env = row.env ? (JSON.parse(row.env) as Record<string, string>) : {}; } catch { /* malformed stored env */ }
      const result = await testMcpConnection({ command: row.command, args, env });
      const status = result.ok ? 'connected' : /timed out|timeout/i.test(result.error ?? '') ? 'timeout' : 'error';
      return res.json({ status, message: result.ok ? 'Connected' : result.error, handshakeMs: result.handshakeMs });
    }

    // http: relay a real initialize through the local ingress (full policy
    // path), 5s timeout.
    if (!row.url) return res.status(400).json({ status: 'error', message: 'Server has no endpoint URL' });
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const upstream = await fetch(`http://127.0.0.1:${PROXY_HTTP_PORT}/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
        signal: ctrl.signal,
      });
      const text = await upstream.text();
      let parsed: { error?: { message: string } } | null = null;
      try { parsed = JSON.parse(text) as { error?: { message: string } }; } catch { /* non-JSON */ }
      return res.json({
        status: upstream.ok && !parsed?.error ? 'connected' : 'error',
        message: parsed?.error?.message ?? (upstream.ok ? 'Connected' : `HTTP ${upstream.status}`),
        handshakeMs: Date.now() - t0,
      });
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      return res.json({
        status: aborted ? 'timeout' : 'error',
        message: aborted ? 'Initialize timed out (no response in 5s)' : (err as Error).message,
        handshakeMs: Date.now() - t0,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    res.status(500).json({ status: 'error', message: err instanceof Error ? err.message : 'Connection test failed' });
  }
});

// Register a new MCP server (manual add flow). stdio: command + args + env
// (env stored in the existing mcp_servers.env column, never echoed back).
// http: url + optional auth block (auth_type + headers — the existing
// headers column is the single credential store). A stdio server is spawned
// immediately so it is usable without a backend restart.
router.post('/', (req, res) => {
  try {
    const { name, type, command, args, url, env, auth_type, headers } = req.body as {
      name?: string;
      type?: string;
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
      auth_type?: string;
      headers?: Record<string, string>;
    };
    if (!name || !name.trim()) return res.status(400).json({ error: 'Server name required' });
    const trimmedName = name.trim();
    const t = type === 'http' ? 'http' : 'stdio';
    if (t === 'stdio' && (!command || !command.trim())) {
      return res.status(400).json({ error: 'Launch command required for stdio servers' });
    }
    if (t === 'http' && (!url || !url.trim())) {
      return res.status(400).json({ error: 'URL required for http servers' });
    }
    if (t === 'http' && isProxyIngressUrl(url!.trim())) {
      return res.status(400).json({ error: 'URL points at Context Fence\'s own HTTP ingress — a server cannot be its own upstream' });
    }

    const exists = db.prepare('SELECT name, removed FROM mcp_servers WHERE name = ?').get(trimmedName) as { name: string; removed: number } | undefined;
    if (exists && exists.removed === 0) {
      return res.status(409).json({ error: `A server named "${trimmedName}" is already registered` });
    }

    const envClean: Record<string, string> = {};
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        if (k.trim()) envClean[k.trim()] = String(v ?? '');
      }
    }
    const headersClean: Record<string, string> = {};
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (k.trim() && v !== undefined) headersClean[k.trim()] = String(v);
      }
    }
    const authType = ['apikey', 'bearer', 'oauth2'].includes(auth_type ?? '') ? auth_type! : 'none';

    if (exists && exists.removed === 1) {
      db.prepare(
        `UPDATE mcp_servers
         SET type = ?, url = ?, command = ?, args = ?, env = ?, headers = ?, auth_type = ?,
             connected = 0, removed = 0, last_check = datetime('now'), created_at = datetime('now')
         WHERE name = ?`,
      ).run(
        t,
        t === 'http' ? url!.trim() : null,
        t === 'stdio' ? command!.trim() : null,
        args && args.length > 0 ? JSON.stringify(args.map(String)) : null,
        Object.keys(envClean).length > 0 ? JSON.stringify(envClean) : null,
        Object.keys(headersClean).length > 0 ? JSON.stringify(headersClean) : null,
        authType,
        trimmedName,
      );
    } else {
      db.prepare(
        `INSERT INTO mcp_servers (name, type, url, command, args, env, headers, auth_type, connected, removed, last_check, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'), datetime('now'))`,
      ).run(
        trimmedName,
        t,
        t === 'http' ? url!.trim() : null,
        t === 'stdio' ? command!.trim() : null,
        args && args.length > 0 ? JSON.stringify(args.map(String)) : null,
        Object.keys(envClean).length > 0 ? JSON.stringify(envClean) : null,
        Object.keys(headersClean).length > 0 ? JSON.stringify(headersClean) : null,
        authType,
      );
    }

    let spawned = true;
    let spawnError: string | null = null;
    if (t === 'stdio') {
      const result = spawnRegisteredServer(trimmedName);
      spawned = result.ok;
      spawnError = result.error ?? null;
      db.prepare("UPDATE mcp_servers SET connected = ?, last_check = datetime('now') WHERE name = ?")
        .run(spawned ? 1 : 0, trimmedName);
    }

    broadcast('connector.status', { name: trimmedName });
    const server = getRegisteredServers().find((s) => s.name === trimmedName) ?? null;
    res.json({ ok: true, server: server ? enrichServer(server) : null, spawned, spawnError });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to register server' });
  }
});

// Update a connector's config (auth block, url, command, env). Credentials:
// the client sends ONLY values it wants to set; existing stored values are
// kept when the body omits them (never echoed back). auth_type drives which
// convention applies.
router.patch('/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const { url, command, args, env, auth_type, headers, clear_credentials } = req.body as {
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      auth_type?: string;
      headers?: Record<string, string>;
      clear_credentials?: boolean;
    };

    const next: Record<string, string | null> = {};
    if (url !== undefined) {
      if (isProxyIngressUrl(url.trim())) {
        return res.status(400).json({ error: 'URL points at Context Fence\'s own HTTP ingress — a server cannot be its own upstream' });
      }
      next.url = url.trim() || null;
    }
    if (command !== undefined) next.command = command.trim() || null;
    if (args !== undefined) next.args = args.length > 0 ? JSON.stringify(args.map(String)) : null;
    if (env !== undefined) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) {
        if (k.trim()) clean[k.trim()] = String(v ?? '');
      }
      next.env = Object.keys(clean).length > 0 ? JSON.stringify(clean) : null;
    }
    if (auth_type !== undefined) {
      next.auth_type = ['apikey', 'bearer', 'oauth2'].includes(auth_type) ? auth_type : 'none';
    }
    if (headers !== undefined) {
      // Merge mode: only keys present in the body are replaced; absent keys
      // keep their stored value. The __oauth block is replaced as a unit.
      const stored = parseStoredHeaders(String(row.headers ?? ''));
      const merged: Record<string, string> = { ...stored };
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        if (k === '__oauth') {
          if (typeof v === 'object' && v !== null) merged.__oauth = JSON.stringify(v);
          else delete merged.__oauth;
        } else if (String(v).trim() === '') {
          delete merged[k];
        } else {
          merged[k] = String(v);
        }
      }
      next.headers = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
    }
    if (clear_credentials) {
      const stored = parseStoredHeaders(String(row.headers ?? ''));
      for (const k of Object.keys(stored)) delete stored[k];
      next.headers = Object.keys(stored).length > 0 ? JSON.stringify(stored) : null;
    }

    if (Object.keys(next).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    const sets = Object.keys(next).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE mcp_servers SET ${sets}, last_check = datetime('now') WHERE name = ?`).run(...Object.values(next), name);

    // Restart the stdio child with the new config if the launch line changed.
    if (next.command !== undefined || next.args !== undefined || next.env !== undefined) {
      stopServer(name);
      if (next.command) {
        spawnRegisteredServer(name);
      }
    }
    broadcast('connector.status', { name });
    const server = getRegisteredServers().find((s) => s.name === name) ?? null;
    res.json({ ok: true, server: server ? enrichServer(server) : null });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update server' });
  }
});

// Unregister: soft-delete the row (removed=1) and stop the live child if it
// is spawned. Soft-delete (not DELETE) because the 30s discovery scan re-reads
// agent configs and would otherwise resurrect a connector the user removed —
// especially Cline/opencode MCPs that live on disk with no per-entry switch
// off. The row stays tombstoned so scans skip it (WHERE removed=0) and never
// re-INSERT it. Foreign-key rows (discovered_tools / agent_connectors) cascade
// off with the hard DELETE the discovery pass uses for full re-syncs.
router.delete('/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    stopServer(name);
    db.prepare('UPDATE mcp_servers SET removed = 1, connected = 0 WHERE name = ?').run(name);
    db.prepare('DELETE FROM discovered_tools WHERE server_name = ?').run(name);
    db.prepare('DELETE FROM agent_connectors WHERE server_name = ?').run(name);
    broadcast('connector.status', { name, deleted: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to remove server' });
  }
});

// ── Connector management ────────────────────────────────────────────────────

// Single-connector detail: row + discovered tools (with per-tool policy
// state folded in) + agent bindings + today's call counts.
router.get('/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const row = getRegisteredServers().find((s) => s.name === name);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const policyRules = db.prepare('SELECT name, action, tools FROM custom_policies').all() as { name: string; action: string; tools: string | null }[];
    const toolRows = db
      .prepare('SELECT tool_name as toolName, tool_schema as toolSchema, last_synced_at as lastSyncedAt FROM discovered_tools WHERE server_name = ? ORDER BY tool_name')
      .all(name) as { toolName: string; toolSchema: string; lastSyncedAt: string }[];
    const tools = toolRows.map((t) => {
      let schema: unknown = {};
      try { schema = JSON.parse(t.toolSchema); } catch { /* keep empty */ }
      const rule = policyRules.find((p) => (p.tools ?? '').split(',').map((x) => x.trim()).includes(t.toolName) && p.name === `connector:${name}:${t.toolName}`);
      return {
        name: t.toolName,
        schema,
        lastSyncedAt: t.lastSyncedAt,
        policy: rule ? { ruleName: rule.name, action: rule.action } : null,
      };
    });

    res.json({
      server: enrichServer(row),
      tools,
      lastSync: (db.prepare('SELECT MAX(last_synced_at) as at FROM discovered_tools WHERE server_name = ?').get(name) as { at: string | null }).at,
      stats: {
        // "today" follows the SYSTEM clock: local midnight converted back to
        // UTC ('localtime' -> 'start of day' -> 'utc'), so counts reset at the
        // user's local midnight rather than UTC's.
        today: (db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE server = ? AND timestamp >= datetime('now', 'localtime', 'start of day', 'utc')").get(name) as { n: number }).n,
        blockedToday: (db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE server = ? AND decision = 'deny' AND timestamp >= datetime('now', 'localtime', 'start of day', 'utc')").get(name) as { n: number }).n,
        hourly: db
          .prepare(
            `SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, decision, COUNT(*) as count
             FROM audit_log
             WHERE server = ? AND timestamp >= datetime('now', '-24 hours')
             GROUP BY hour, decision`,
          )
          .all(name) as { hour: number; decision: string; count: number }[],
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch server detail' });
  }
});

// ── Per-agent config view ───────────────────────────────────────────────────
// Which detected agents' configs declare THIS server, and whether each
// declaration still matches what Context Fence has registered. Powers the
// ConnectorDetail "Per-Agent Override" tab.
//
// Secrets rule: env values here come from the LOCAL agent config files /
// local DB row — the same plaintext the user can open on disk. The API only
// exposes them for this single-server inspection surface; list endpoints
// still carry key names only.
router.get('/:name/agent-configs', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const row = db
      .prepare('SELECT name, type, url, command, args, env FROM mcp_servers WHERE name = ?')
      .get(name) as { name: string; type: string; url: string | null; command: string | null; args: string | null; env: string | null } | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const regArgs: string[] = (() => {
      try { const parsed = JSON.parse(row.args ?? '[]'); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
    })();
    const regEnv: Record<string, string> = (() => {
      try { const parsed = JSON.parse(row.env ?? '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)])) : {}; }
      catch { return {}; }
    })();
    const registeredCommand = [...(row.command ? [row.command] : []), ...regArgs];
    const registered = {
      name: row.name,
      type: row.type,
      url: row.url,
      command: registeredCommand,
      args: regArgs,
      env: regEnv,
    };

    const argvOf = (e: { command?: string[]; url?: string }): string[] =>
      e.url ? [] : (e.command ?? []);
    const sameArray = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    // In sync = same transport + same invocation (or the agent was rewired
    // through our ingress by the protect flow — that IS the intended state).
    const isInSync = (entryUrl: string | undefined, entryCommand: string[]): boolean => {
      if (entryUrl) {
        if (isProxyIngressUrl(entryUrl)) return true;
        return !!row.url && entryUrl === row.url;
      }
      return !row.url && sameArray(entryCommand, registeredCommand);
    };

    const agents: {
      agentName: string;
      agentPath: string;
      command: string[];
      args: string[];
      url: string | null;
      env: Record<string, string>;
      rewired: boolean;
      inSync: boolean;
    }[] = [];

    for (const adapter of AGENT_ADAPTERS) {
      // Never let one slow/stuck adapter block the panel: 2s cap per read.
      let read: Awaited<ReturnType<typeof adapter.read>> | null = null;
      try {
        read = await Promise.race([
          Promise.resolve(adapter.read()),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]);
      } catch { continue; }
      if (!read?.exists) continue;
      for (const e of read.entries) {
        if (e.name !== name) continue;
        const rewired = !!e.url && isProxyIngressUrl(e.url);
        agents.push({
          agentName: read.name,
          agentPath: e.source || read.path,
          command: e.url ? [] : (e.command ?? []),
          args: [],
          url: e.url ?? null,
          env: e.env ?? {},
          rewired,
          inSync: isInSync(e.url, e.command ?? []),
        });
      }
    }

    res.json({ registered, agents });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to inspect agent configs' });
  }
});

// ── OAuth authorization-code flow (backend half) ──────────────────────────
// Contract (main process ↔ backend, see electron/oauth-flow.js):
//   1. GET  /:name/oauth-config — public flow facts (auth URL, client_id,
//      scope, resource). NEVER returns client_secret or stored tokens.
//   2. POST /:name/oauth/discover — MCP spec discovery (RFC 9728 → 8414) to
//      auto-populate the config form from a provider that publishes metadata.
//   3. POST /:name/oauth/token — the code exchange. Called by the Electron
//      main process after the loopback callback; the client_secret stays in
//      the DB here and never crosses IPC or the API.

router.get('/:name/oauth-config', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const row = db.prepare('SELECT name, url, headers, auth_type FROM mcp_servers WHERE name = ?').get(name) as
      { name: string; url: string | null; headers: string | null; auth_type: string } | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const block = parseOauthBlock(row.headers);
    if (!block || row.auth_type !== 'oauth2') {
      return res.status(400).json({ ok: false, error: 'OAuth2 is not configured for this connector' });
    }
    res.json({
      ok: true,
      config: {
        authorization_url: block.authorization_url ?? null,
        token_url: block.token_url,
        client_id: block.client_id,
        scope: block.scope ?? null,
        use_pkce: block.use_pkce !== false,
        resource: row.url,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch oauth config' });
  }
});

router.post('/:name/oauth/discover', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const row = db.prepare('SELECT name, url FROM mcp_servers WHERE name = ?').get(name) as
      { name: string; url: string | null } | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });
    if (!row.url) return res.status(400).json({ ok: false, error: 'Server has no endpoint URL to discover from' });
    const result = await discoverOauthEndpoints(row.url);
    if (!result.ok) return res.status(422).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Discovery failed' });
  }
});

// One-click Connect: ensure a flowable config exists — discover the
// provider's endpoints (RFC 9728 → 8414) and, if the provider supports it,
// dynamically register this desktop client (RFC 7591) so no client_id needs
// to be typed. Called by the Electron main process with the loopback
// redirect_uri BEFORE the browser opens.
router.post('/:name/oauth/register', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { redirect_uri } = req.body as { redirect_uri?: string };
    if (!redirect_uri || !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirect_uri)) {
      return res.status(400).json({ ok: false, error: 'redirect_uri must be a loopback callback URL' });
    }
    const row = db.prepare('SELECT name, url, headers, auth_type FROM mcp_servers WHERE name = ?').get(name) as
      { name: string; url: string | null; headers: string | null; auth_type: string } | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const hr = { name: row.name, url: row.url ?? '', headers: row.headers, authType: row.auth_type };
    const result = await registerOauthClient(hr, redirect_uri);
    if (!result.ok) return res.status(422).json(result);
    broadcast('connector.status', { name });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Registration failed' });
  }
});

router.post('/:name/oauth/token', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { code, redirect_uri, code_verifier } = req.body as {
      code?: string;
      redirect_uri?: string;
      code_verifier?: string;
    };
    if (!code || !redirect_uri || !code_verifier) {
      return res.status(400).json({ ok: false, error: 'code, redirect_uri and code_verifier are required' });
    }
    const row = db.prepare('SELECT name, url, headers, auth_type FROM mcp_servers WHERE name = ?').get(name) as
      { name: string; url: string | null; headers: string | null; auth_type: string } | undefined;
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const hr = { name: row.name, url: row.url ?? '', headers: row.headers, authType: row.auth_type };
    const result = await exchangeOauthCode(hr, code, redirect_uri, code_verifier);
    if (!result.ok) return res.status(400).json(result);
    // Auto-sync after a successful connect: the user's one click should end
    // with the card already "Connected" — not a waiting-for-sync state.
    const sync = await discoverTools(name);
    if (sync.ok) {
      const upsert = db.prepare(`
        INSERT INTO discovered_tools (server_name, tool_name, tool_schema, last_synced_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(server_name, tool_name) DO UPDATE SET
          tool_schema = excluded.tool_schema,
          last_synced_at = excluded.last_synced_at
      `);
      db.prepare('DELETE FROM discovered_tools WHERE server_name = ?').run(name);
      const MAX_TOOLS = 500;
      for (const t of sync.tools.slice(0, MAX_TOOLS)) {
        upsert.run(name, t.name, JSON.stringify({ description: t.description, inputSchema: t.inputSchema }));
      }
      db.prepare("UPDATE mcp_servers SET connected = 1, last_check = datetime('now') WHERE name = ?").run(name);
    } else {
      db.prepare("UPDATE mcp_servers SET connected = 0, last_check = datetime('now') WHERE name = ?").run(name);
    }
    broadcast('connector.status', { name });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Token exchange failed' });
  }
});

// Live tool sync (NODE 2): run a real MCP handshake + tools/list through the
// proxy layer, upsert discovered_tools, and record the outcome on the row.
// Failures return the concrete reason with ok:false — the UI renders the
// card's "connection failed" state with retry + edit-credentials actions.
router.post('/:name/sync-tools', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const result = await discoverTools(name);
    if (result.ok) {
      const upsert = db.prepare(`
        INSERT INTO discovered_tools (server_name, tool_name, tool_schema, last_synced_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(server_name, tool_name) DO UPDATE SET
          tool_schema = excluded.tool_schema,
          last_synced_at = excluded.last_synced_at
      `);
      db.prepare('DELETE FROM discovered_tools WHERE server_name = ?').run(name);
      // Cap stored tools per server: a misbehaving/failed MCP must not
      // balloon the tool table (or the card's tool count) into the
      // thousands. 500 is far above any real server's surface.
      const MAX_TOOLS = 500;
      for (const t of result.tools.slice(0, MAX_TOOLS)) {
        upsert.run(name, t.name, JSON.stringify({ description: t.description, inputSchema: t.inputSchema }));
      }
      db.prepare("UPDATE mcp_servers SET connected = 1, last_check = datetime('now') WHERE name = ?").run(name);
      broadcast('connector.status', { name, connected: true });
      res.json({ ok: true, toolCount: Math.min(result.tools.length, MAX_TOOLS), durationMs: result.durationMs, truncated: result.tools.length > MAX_TOOLS });
    } else {
      db.prepare("UPDATE mcp_servers SET connected = 0, last_check = datetime('now') WHERE name = ?").run(name);
      broadcast('connector.status', { name, connected: false });
      res.status(502).json({ ok: false, error: result.error, durationMs: result.durationMs });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Tool sync failed' });
  }
});

// One-shot "fetch": make a server fully usable in one call. Ensures the
// server is registered, (re)spawns a stdio child if none is running, then
// runs a live tools/list through the proxy and stores the tools — the whole
// sequence a freshly added MCP needs before it shows tools / can be called.
// Wired to the AddMCPModal save flow + scripts/trigger-mcp-fetch.mjs.
router.post('/:name/fetch', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const row = getRegisteredServers().find((s) => s.name === name);
    if (!row) return res.status(404).json({ ok: false, error: 'Server not found' });

    let spawned = true;
    let spawnError: string | null = null;
    if (row.type === 'stdio') {
      const result = spawnRegisteredServer(name);
      spawned = result.ok;
      spawnError = result.error ?? null;
    }

    // First run of a fresh `npx -y …` command pays the package download
    // before the initialize handshake can complete — retry the live
    // tools/list a few times so a slow first spawn still fetches.
    let result = await discoverTools(name);
    for (let attempt = 1; !result.ok && attempt <= 3; attempt++) {
      await new Promise((r) => setTimeout(r, 2500));
      result = await discoverTools(name);
    }
    if (result.ok) {
      const upsert = db.prepare(`
        INSERT INTO discovered_tools (server_name, tool_name, tool_schema, last_synced_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(server_name, tool_name) DO UPDATE SET
          tool_schema = excluded.tool_schema,
          last_synced_at = excluded.last_synced_at
      `);
      db.prepare('DELETE FROM discovered_tools WHERE server_name = ?').run(name);
      const MAX_TOOLS = 500;
      for (const t of result.tools.slice(0, MAX_TOOLS)) {
        upsert.run(name, t.name, JSON.stringify({ description: t.description, inputSchema: t.inputSchema }));
      }
      db.prepare("UPDATE mcp_servers SET connected = 1, last_check = datetime('now') WHERE name = ?").run(name);
      broadcast('connector.status', { name, connected: true });
      res.json({
        ok: true,
        spawned,
        spawnError,
        toolCount: Math.min(result.tools.length, MAX_TOOLS),
        truncated: result.tools.length > MAX_TOOLS,
        durationMs: result.durationMs,
      });
    } else {
      db.prepare("UPDATE mcp_servers SET connected = 0, last_check = datetime('now') WHERE name = ?").run(name);
      broadcast('connector.status', { name, connected: false });
      res.status(502).json({ ok: false, spawned, spawnError, error: result.error, durationMs: result.durationMs });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Fetch failed' });
  }
});

// Stored tool inventory (no live handshake).
router.get('/:name/tools', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const rows = db
      .prepare('SELECT tool_name as toolName, tool_schema as toolSchema, last_synced_at as lastSyncedAt FROM discovered_tools WHERE server_name = ? ORDER BY tool_name')
      .all(name) as { toolName: string; toolSchema: string; lastSyncedAt: string }[];
    res.json({ tools: rows.map((r) => ({ name: r.toolName, schema: (() => { try { return JSON.parse(r.toolSchema); } catch { return {}; } })(), lastSyncedAt: r.lastSyncedAt })) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch tools' });
  }
});

// Agent bindings for a connector.
router.get('/:name/agents', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const bindings = db
      .prepare('SELECT agent_type as agentType, enabled, bound_at as boundAt FROM agent_connectors WHERE server_name = ?')
      .all(name) as { agentType: string; enabled: number; boundAt: string }[];
    res.json({ bindings: bindings.map((b) => ({ ...b, protected: isProtected(b.agentType) })) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch bindings' });
  }
});

// Bind/unbind a connector to an agent (NODE 4). Binding rewires the agent's
// config entry to the proxy (same protect path, per entry); unbinding
// reverses ONLY this server's entry. stdio connectors bind as records only —
// the rewriter only re-points HTTP entries, and the response says so.
router.post('/:name/agents', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { agentType, enabled } = req.body as { agentType?: string; enabled?: boolean };
    if (!agentType) return res.status(400).json({ error: 'agentType required' });

    const server = db.prepare('SELECT name, type, url, command, args, env FROM mcp_servers WHERE name = ?').get(name) as {
      name: string;
      type: string;
      url: string | null;
      command: string | null;
      args: string | null;
      env: string | null;
    } | undefined;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    if (enabled === false) {
      // Unbind: restore original URL/stdio or cleanly remove entry from the agent's config
      try {
        unbindServerFromAgent(agentType, name);
      } catch (err) {
        console.warn(`[servers] unbind ${name} from ${agentType}:`, err instanceof Error ? err.message : String(err));
      }
      // Soft-unbind (enabled=0, origin='manual'): the row stays so the 30s
      // discovery scan — which only re-asserts origin='discovered' rows —
      // cannot resurrect an explicit unbind while the config still declares
      // the server.
      db.prepare(`
        INSERT INTO agent_connectors (agent_type, server_name, enabled, bound_at, origin)
        VALUES (?, ?, 0, datetime('now'), 'manual')
        ON CONFLICT(agent_type, server_name) DO UPDATE SET enabled = 0, origin = 'manual'
      `).run(agentType, name);
      broadcast('connector.status', { name, agent: agentType, bound: false });
      return res.json({ ok: true, bound: false, rewired: false });
    }

    // Bind: write entry to the agent's config if an adapter exists, and ensure HTTP config is proxied
    let rewired = false;
    let protectError: string | null = null;

    try {
      const adapter = AGENT_ADAPTERS.find(
        (a) => a.name.toLowerCase().replace(/[\s-_]+/g, '') === agentType.toLowerCase().replace(/[\s-_]+/g, '') ||
               a.name.toLowerCase().includes(agentType.toLowerCase()) ||
               agentType.toLowerCase().includes(a.name.toLowerCase())
      );
      if (adapter) {
        let args: string[] = [];
        try { args = server.args ? (JSON.parse(server.args) as string[]) : []; } catch { /* ignore */ }
        let envObj: Record<string, string> = {};
        try { envObj = server.env ? (JSON.parse(server.env) as Record<string, string>) : {}; } catch { /* ignore */ }
        const cmd = server.command ? [server.command, ...args] : [];
        const proxyUrl = `http://127.0.0.1:3002/${encodeURIComponent(name)}`;
        adapter.write([{
          name,
          type: 'http',
          command: cmd,
          url: proxyUrl,
          env: Object.keys(envObj).length > 0 ? envObj : undefined,
          source: 'context-fence',
        }]);
      }
    } catch {
      // Non-fatal if config write is not directly supported
    }

    if (server.type === 'http' || isProtected(agentType)) {
      try {
        protectAgent(agentType);
        rewired = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (/already protected/.test(msg)) {
          rewired = true;
        } else {
          protectError = msg;
        }
      }
    }
    db.prepare(`
      INSERT INTO agent_connectors (agent_type, server_name, enabled, bound_at, origin)
      VALUES (?, ?, 1, datetime('now'), 'manual')
      ON CONFLICT(agent_type, server_name) DO UPDATE SET enabled = 1, bound_at = datetime('now'), origin = 'manual'
    `).run(agentType, name);

    broadcast('connector.status', { name, agent: agentType, bound: true });
    res.json({ ok: true, bound: true, rewired, protectError });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update binding' });
  }
});

// Import a detected connector (NODE 1): reads the full entry from the agent's
// config server-side, writes mcp_servers (values never cross the API), binds
// it to that agent, and triggers a live tool sync.
router.post('/:name/import', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { agentType } = req.body as { agentType?: string };
    if (!agentType) return res.status(400).json({ error: 'agentType required' });

    const cfg = getConnectorConfigForImport(agentType, name);
    if (!cfg) return res.status(404).json({ error: `No entry for "${name}" found in the ${agentType} config` });

    // Self-loop guard: the config entry already points at our own ingress
    // (rewired by a previous sync). Registering it as an HTTP row would make
    // the proxy fetch itself forever. healSelfLoopRows() rebuilds the real
    // row from the agent backup; import just binds + syncs the existing row.
    if (cfg.url && isProxyIngressUrl(cfg.url)) {
      const existing = db.prepare('SELECT name FROM mcp_servers WHERE name = ?').get(name) as { name: string } | undefined;
      if (!existing) {
        return res.status(409).json({
          ok: false,
          error: `"${name}" is already rewired to the Context Fence proxy in the ${agentType} config (URL ${cfg.url}). Its real destination lives in the ${agentType} backup — run a Sync on the agent instead of Import to rebuild the row.`,
        });
      }
      db.prepare(`
        INSERT INTO agent_connectors (agent_type, server_name, enabled, bound_at)
        VALUES (?, ?, 1, datetime('now'))
        ON CONFLICT(agent_type, server_name) DO UPDATE SET enabled = 1, bound_at = datetime('now')
      `).run(agentType, name);
      broadcast('connector.status', { name, imported: true });
      const existingServer = getRegisteredServers().find((s) => s.name === name) ?? null;
      return res.json({ ok: true, imported: false, server: existingServer ? enrichServer(existingServer) : null, sync: { ok: false, error: 'already rewired — run agent Sync to heal', toolCount: 0 } });
    }

    const existing = db.prepare('SELECT name FROM mcp_servers WHERE name = ?').get(name) as { name: string } | undefined;
    if (!existing) {
      const headersJson = cfg.headers && Object.keys(cfg.headers).length > 0 ? JSON.stringify(cfg.headers) : null;
      db.prepare(
        `INSERT INTO mcp_servers (name, type, url, command, args, env, headers, auth_type, connected, last_check, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
      ).run(
        name,
        cfg.type,
        cfg.url ?? null,
        cfg.command ?? null,
        cfg.args && cfg.args.length > 0 ? JSON.stringify(cfg.args) : null,
        cfg.env && Object.keys(cfg.env).length > 0 ? JSON.stringify(cfg.env) : null,
        headersJson,
        cfg.headers && cfg.headers.Authorization ? 'bearer' : 'none',
      );
      if (cfg.type === 'stdio') {
        const r = spawnRegisteredServer(name);
        db.prepare("UPDATE mcp_servers SET connected = ?, last_check = datetime('now') WHERE name = ?").run(r.ok ? 1 : 0, name);
      }
    }
    db.prepare(`
      INSERT INTO agent_connectors (agent_type, server_name, enabled, bound_at, origin)
      VALUES (?, ?, 1, datetime('now'), 'manual')
      ON CONFLICT(agent_type, server_name) DO UPDATE SET enabled = 1, bound_at = datetime('now'), origin = 'manual'
    `).run(agentType, name);

    const sync = await discoverTools(name);
    if (sync.ok) {
      const upsert = db.prepare(`
        INSERT INTO discovered_tools (server_name, tool_name, tool_schema, last_synced_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(server_name, tool_name) DO UPDATE SET
          tool_schema = excluded.tool_schema,
          last_synced_at = excluded.last_synced_at
      `);
      db.prepare('DELETE FROM discovered_tools WHERE server_name = ?').run(name);
      const MAX_TOOLS = 500;
      for (const t of sync.tools.slice(0, MAX_TOOLS)) {
        upsert.run(name, t.name, JSON.stringify({ description: t.description, inputSchema: t.inputSchema }));
      }
      db.prepare("UPDATE mcp_servers SET connected = 1, last_check = datetime('now') WHERE name = ?").run(name);
    } else {
      db.prepare("UPDATE mcp_servers SET connected = 0, last_check = datetime('now') WHERE name = ?").run(name);
    }

    broadcast('connector.status', { name, imported: true });
    const server = getRegisteredServers().find((s) => s.name === name) ?? null;
    res.status(existing ? 200 : 201).json({
      ok: true,
      imported: !existing,
      server: server ? enrichServer(server) : null,
      sync: { ok: sync.ok, error: sync.error ?? null, toolCount: Math.min(sync.tools.length, 500) },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
  }
});

// Per-connector activity: hourly call counts from audit_log (real data, the
// card sparkline source).
router.get('/:name/stats', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const hourly = db
      .prepare(
        `SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, decision, COUNT(*) as count
         FROM audit_log
         WHERE server = ? AND timestamp >= datetime('now', '-24 hours')
         GROUP BY hour, decision`,
      )
      .all(name) as { hour: number; decision: string; count: number }[];
    res.json({
      server: name,
      today: (db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE server = ? AND timestamp >= datetime('now', 'start of day')").get(name) as { n: number }).n,
      blockedToday: (db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE server = ? AND decision = 'deny' AND timestamp >= datetime('now', 'start of day')").get(name) as { n: number }).n,
      hourly,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch server stats' });
  }
});

export default router;
