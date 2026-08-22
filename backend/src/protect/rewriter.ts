import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { parse, modify, applyEdits } from 'jsonc-parser';
import db from '../db/index.js';
import { PROXY_HTTP_PORT } from '../mcp/proxy.js';
import { AGENT_PATHS, isProxyIngressUrl } from '../agent-det/detector.js';

// mtimeMs of every config file WE last wrote (protect/sync/unprotect/unbind).
// The install-gap heuristic in index.ts skips paths we wrote ourselves — a
// protect rewrite or an unprotect restore changes mtime without adding MCP
// entries, which would otherwise broadcast "install reported success but no
// new entry detected" after the user's own unprotect click.
export const selfWrittenConfigs = new Map<string, number>();

function noteSelfWrite(path: string): void {
  try {
    selfWrittenConfigs.set(path, statSync(path).mtimeMs);
  } catch {
    selfWrittenConfigs.delete(path);
  }
}

// Per-agent proxy re-wiring (P12, ADR-proxy-injection.md). "Protect" backs
// up the agent's real MCP config file (byte-for-byte, timestamped), then
// rewrites each HTTP/remote server entry to point at Context Fence's HTTP
// MCP ingress (http://127.0.0.1:3002/<server>), registering the server's
// REAL destination (and the auth header the agent holds for it) in the
// mcp_servers table so the proxy can forward correctly. "Unprotect" restores
// the original bytes from the backup and verifies the content hash.

interface McpEntry {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: Record<string, string>;
  /** stdio entries: opencode uses `command: string[]`; claude-code uses
   *  `command: string` + `args: string[]` + `env: Record<string,string>`. */
  command?: string | string[];
  args?: unknown;
  env?: unknown;
  type?: string;
  enabled?: boolean;
}

interface ParsedMcpConfig {
  containerKey: 'mcp' | 'mcpServers';
  entries: Map<string, McpEntry>;
  raw: string;
}

const PROXY_RE = 'http://127\\.0\\.0\\.1:';

function isProxyUrl(url: string): boolean {
  return new RegExp(`^${PROXY_RE}${PROXY_HTTP_PORT}/`, 'i').test(url);
}

function jsoncEditsEditable(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  return { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** Register (or update) an HTTP server's real destination in mcp_servers and
 *  carry the auth the agent already holds for it (explicit Authorization
 *  header, or the agent's OAuth token store keyed by exact URL). Returns the
 *  headers JSON to persist (or the previous stored value). */
function registerServerDestination(entry: McpEntry, existing: { headers: string | null } | undefined): { headersJson: string | null; authInjected: boolean } {
  const auth = findAuthForServer(entry.url!, entry);
  const headersJson = auth ? JSON.stringify({ Authorization: auth }) : existing?.headers ?? null;
  return { headersJson, authInjected: !!auth };
}

/** Register (or update) a stdio server's launch command in mcp_servers so the
 *  proxy can spawn it and bridge its stdio transport to the HTTP ingress.
 *  Accepts both config shapes: opencode (`command: string[]`) and
 *  claude-code (`command: string` + `args` + `env`). */
function registerStdioServer(entry: McpEntry): void {
  const cmd = entry.command;
  const command = typeof cmd === 'string' ? cmd : Array.isArray(cmd) ? cmd[0] : '';
  const args = Array.isArray(cmd)
    ? cmd.slice(1)
    : Array.isArray(entry.args)
      ? entry.args.map(String)
      : [];
  const envObj = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
    ? Object.fromEntries(Object.entries(entry.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
    : undefined;
  db.prepare(`
    INSERT INTO mcp_servers (name, type, url, command, args, env, connected, last_check)
    VALUES (?, 'stdio', NULL, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      type = 'stdio', url = NULL, command = excluded.command, args = excluded.args,
      env = excluded.env, connected = 1, last_check = datetime('now')
  `).run(entry.name, command, args.length > 0 ? JSON.stringify(args) : null, envObj ? JSON.stringify(envObj) : null);
}

export function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function findConfigPath(type: string): string | null {
  for (const ap of AGENT_PATHS) {
    if (ap.type === type && existsSync(ap.path)) return ap.path;
  }
  return null;
}

function parseConfigFile(path: string): ParsedMcpConfig {
  const raw = readFileSync(path, 'utf-8');
  const errors: { error: number; offset: number; length: number }[] = [];
  const doc = parse(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error(`Config is not valid JSONC (${errors.length} parse error(s)): ${errors[0]?.error ?? 'unknown'}`);
  }
  const root = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  const containerKey: 'mcp' | 'mcpServers' =
    root.mcp && typeof root.mcp === 'object' ? 'mcp' : 'mcpServers' in root ? 'mcpServers' : 'mcp';
  const container = (root[containerKey] ?? {}) as Record<string, unknown>;

  const entries = new Map<string, McpEntry>();
  for (const [name, value] of Object.entries(container)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const url = typeof entry.url === 'string' ? entry.url : undefined;
    const headers = entry.headers && typeof entry.headers === 'object'
      ? Object.fromEntries(Object.entries(entry.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;
    const oauth = entry.oauth && typeof entry.oauth === 'object'
      ? Object.fromEntries(Object.entries(entry.oauth as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;
    // Only HTTP/remote entries can be re-pointed at the proxy; stdio
    // entries (command-based) keep their transport untouched.
    if (url && /^https?:\/\//i.test(url)) {
      entries.set(name, { name, url, headers, oauth });
    }
    // stdio entries are captured too: sync can register them in mcp_servers
    // and re-point them at the HTTP ingress, which bridges to the spawned
    // child (e.g. Playwright MCP). protectAgent still skips them.
    const command = entry.command;
    if (!url && command !== undefined && (typeof command === 'string' || Array.isArray(command))) {
      entries.set(name, {
        name,
        command: command as string | string[],
        args: entry.args,
        env: entry.env,
        type: typeof entry.type === 'string' ? entry.type : undefined,
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
      });
    }
  }
  return { containerKey, entries, raw };
}

/** Find the bearer token the agent already holds for a real server URL:
 *  1. an explicit Authorization header in the config entry
 *  2. the agent's OAuth token store (OpenCode's mcp-auth.json), keyed by
 *     the exact server URL — read-only, never modified.
 *  When multiple store records share the same serverUrl, the record whose
 *  token is still valid (not yet expired) wins — same-URL aliases otherwise
 *  collide and an expired token would be injected. */
function findAuthForServer(url: string, entry: McpEntry): string | null {
  if (entry.headers?.Authorization) return entry.headers.Authorization;
  try {
    const authPath = join(homedir(), '.local', 'share', 'opencode', 'mcp-auth.json');
    if (!existsSync(authPath)) return null;
    const store = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<
      string,
      { serverUrl?: string; tokens?: { accessToken?: string; expiresAt?: number } }
    >;
    let best: { accessToken?: string; expiresAt?: number } | null = null;
    let bestExpiry = -Infinity;
    for (const record of Object.values(store)) {
      if (record?.serverUrl !== url || !record.tokens?.accessToken) continue;
      const expiry = typeof record.tokens.expiresAt === 'number' ? record.tokens.expiresAt : Infinity;
      if (expiry > bestExpiry) {
        bestExpiry = expiry;
        best = record.tokens;
      }
    }
    if (best?.accessToken) return `Bearer ${best.accessToken}`;
  } catch { /* no token store readable */ }
  return null;
}

export interface ProtectResult {
  type: string;
  configPath: string;
  backupPath: string;
  rewrittenServers: { name: string; realUrl: string; from: string; to: string }[];
  authInjected: string[];
  skippedStdio: string[];
}

/** Back up + rewrite one agent's config so its HTTP MCP servers point at the
 *  proxy. Reversible via unprotectAgent. Throws on any failure AFTER the
 *  backup is written, restoring the original bytes first. */
export function protectAgent(type: string): ProtectResult {
  const configPath = findConfigPath(type);
  if (!configPath) throw new Error(`No config file found for agent type "${type}"`);
  if (db.prepare('SELECT type FROM protected_agents WHERE type = ?').get(type)) {
    throw new Error(`Agent "${type}" is already protected`);
  }

  const { raw, entries, containerKey } = parseConfigFile(configPath);
  if (entries.size === 0) {
    throw new Error(`No HTTP/remote MCP servers found in ${configPath} — nothing to protect`);
  }

  const backupPath = `${configPath}.cf-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(backupPath, raw);
  const originalHash = sha256Of(raw);

  const rewrittenServers: ProtectResult['rewrittenServers'] = [];
  const authInjected: string[] = [];
  const skippedStdio: string[] = [];
  const originalHeaders: Record<string, string | null> = {};

  try {
    let text = raw;
        for (const entry of entries.values()) {
      const proxyUrl = `http://127.0.0.1:${PROXY_HTTP_PORT}/${encodeURIComponent(entry.name)}`;
      const fmt = { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
      const pathPrefix = [containerKey, entry.name];

      // Bind the (agent, server) pair so the TestMCP / Connectors views show
      // the real agent that owns this connector (e.g. OpenCode, Cline) instead
      // of reporting "no agents".
      db.prepare(`
        INSERT INTO agent_connectors (agent_type, server_name, enabled, bound_at)
        VALUES (?, ?, 1, datetime('now'))
        ON CONFLICT(agent_type, server_name) DO UPDATE SET enabled = 1, bound_at = datetime('now')
      `).run(type, entry.name);

      if (!entry.url) {
        // stdio (command-based) entry — e.g. Cline/OpenCode/Claude's `npx ...`.
        // Register the launch command in mcp_servers so the proxy can spawn it,
        // then re-point the config entry at the HTTP ingress. The ingress
        // bridges HTTP→stdio and runs every call through the normal firewall
        // pipeline (evaluate → deny/log/allow), so a stdio agent becomes fully
        // monitored & blockable instead of spawning a private child that
        // bypasses Context Fence entirely.
        registerStdioServer(entry);
        text = applyEdits(text, modify(text, [...pathPrefix, 'url'], proxyUrl, { formattingOptions: fmt }));
        // Always pin the transport: opencode's `local` becomes `remote`;
        // Cline/Claude-style entries (type `stdio`, or NO type at all — Cline's
        // playwright entry is a bare `{ command, args }`) become `http` so the
        // agent unambiguously speaks streamable-HTTP to the ingress instead of
        // trying to spawn a command that no longer exists.
        text = applyEdits(
          text,
          modify(text, [...pathPrefix, 'type'], entry.type === 'local' ? 'remote' : 'http', { formattingOptions: fmt }),
        );
        text = applyEdits(text, modify(text, [...pathPrefix, 'command'], undefined, { formattingOptions: fmt }));
        if (entry.args !== undefined) {
          text = applyEdits(text, modify(text, [...pathPrefix, 'args'], undefined, { formattingOptions: fmt }));
        }
        if (entry.env !== undefined) {
          text = applyEdits(text, modify(text, [...pathPrefix, 'env'], undefined, { formattingOptions: fmt }));
        }
        rewrittenServers.push({ name: entry.name, realUrl: 'stdio:', from: 'stdio', to: proxyUrl });
        continue;
      }

      const realUrl = entry.url;

      // Register (or update) the real destination in mcp_servers, carrying
      // the auth header the agent already holds so the proxy can inject it.
      const existing = db
        .prepare('SELECT headers FROM mcp_servers WHERE name = ?')
        .get(entry.name) as { headers: string | null } | undefined;
      originalHeaders[entry.name] = existing?.headers ?? null;

      const auth = findAuthForServer(realUrl, entry);
      const headersJson = auth
        ? JSON.stringify({ Authorization: auth })
        : existing?.headers ?? null;
      if (auth) authInjected.push(entry.name);

      db.prepare(`
        INSERT INTO mcp_servers (name, type, url, headers, connected, last_check)
        VALUES (?, 'http', ?, ?, 1, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET
          type = 'http', url = excluded.url, headers = excluded.headers,
          connected = 1, last_check = datetime('now')
      `).run(entry.name, realUrl, headersJson);

      // Rewrite: url → proxy ingress; drop the oauth block (the proxy now
      // applies auth; leaving it would make the agent run an OAuth
      // discovery flow against the proxy URL and fail). jsonc-parser edits
      // must be applied one at a time against the evolving text — batching
      // edits computed from the same base causes "Overlapping edit" errors.
      text = applyEdits(text, modify(text, [...pathPrefix, 'url'], proxyUrl, { formattingOptions: fmt }));
      text = applyEdits(text, modify(text, [...pathPrefix, 'oauth'], undefined, { formattingOptions: fmt }));
      rewrittenServers.push({ name: entry.name, realUrl, from: realUrl, to: proxyUrl });
    }

    writeFileSync(configPath, text);
    noteSelfWrite(configPath);

    db.prepare(`
      INSERT INTO protected_agents (type, config_path, backup_path, original_hash, original_headers, protected_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(type) DO UPDATE SET
        config_path = excluded.config_path, backup_path = excluded.backup_path,
        original_hash = excluded.original_hash, original_headers = excluded.original_headers,
        protected_at = excluded.protected_at
    `).run(type, configPath, backupPath, originalHash, JSON.stringify(originalHeaders));

    console.log(`[protect] ${type}: ${rewrittenServers.length} HTTP server(s) rewired to ${proxyUrlHost()}, backup at ${backupPath}`);
    return { type, configPath, backupPath, rewrittenServers, authInjected, skippedStdio };
  } catch (err) {
    // Rollback: the backup exists; restore the original bytes so a failed
    // protect never leaves the agent's config half-rewritten, then remove
    // the backup (the in-memory original is the authoritative copy).
    try { writeFileSync(configPath, raw); } catch { /* best effort */ }
    try { unlinkSync(backupPath); } catch { /* best effort */ }
    throw err;
  }
}

function proxyUrlHost(): string {
  return `127.0.0.1:${PROXY_HTTP_PORT}`;
}

export interface SyncResult {
  type: string;
  configPath: string;
  backupPath: string;
  rewrittenServers: ProtectResult['rewrittenServers'];
  authInjected: string[];
  alreadyWired: string[];
}

/** Rescan an ALREADY-protected agent's config and pull any HTTP/remote MCP
 *  entry that is not yet pointed at the proxy into Context Fence. `protect`
 *  only rewires the entries present at protect time; a connector added to the
 *  agent's config afterwards stays on its real URL and its whole call stream
 *  bypasses the firewall (the exact "blocking has no effect on opencode"
 *  failure: only the handshake-rewired server is policed, the late-added one
 *  keeps talking to the real destination directly). Run after the agent is
 *  protected (e.g. from the connector/agent UI) so connectors registered
 *  later get the same rewrite. Never touches the original backup — the agent
 *  remains protected by the same record, unprotect still restores the
 *  byte-for-byte original. */
export function syncAgentConnectors(type: string): SyncResult {
  const row = db
    .prepare('SELECT config_path, backup_path, original_hash, original_headers FROM protected_agents WHERE type = ?')
    .get(type) as { config_path: string; backup_path: string; original_hash: string; original_headers: string | null } | undefined;
  if (!row) throw new Error(`Agent "${type}" is not protected — protect it first`);

  const { raw, entries, containerKey } = parseConfigFile(row.config_path);
  const fmt = jsoncEditsEditable(raw);
  const rewrittenServers: SyncResult['rewrittenServers'] = [];
  const authInjected: string[] = [];
  const alreadyWired: string[] = [];

  let text = raw;
  for (const entry of entries.values()) {
    if (!entry.url) {
      // stdio entry: register the launch command in mcp_servers and re-point
      // the config entry at the proxy HTTP ingress (which spawns the child
      // and bridges its stdio transport). opencode: type local → remote;
      // claude-code: type stdio → http.
      registerStdioServer(entry);
      const proxyUrl = `http://127.0.0.1:${PROXY_HTTP_PORT}/${encodeURIComponent(entry.name)}`;
      text = applyEdits(text, modify(text, [containerKey, entry.name, 'url'], proxyUrl, { formattingOptions: fmt }));
      // Always pin the transport (`local`→`remote`; `stdio`/missing→`http`) —
      // same rule as protectAgent, kept in lockstep.
      text = applyEdits(
        text,
        modify(text, [containerKey, entry.name, 'type'], entry.type === 'local' ? 'remote' : 'http', { formattingOptions: fmt }),
      );
      text = applyEdits(text, modify(text, [containerKey, entry.name, 'command'], undefined, { formattingOptions: fmt }));
      if (entry.args !== undefined) {
        text = applyEdits(text, modify(text, [containerKey, entry.name, 'args'], undefined, { formattingOptions: fmt }));
      }
      if (entry.env !== undefined) {
        text = applyEdits(text, modify(text, [containerKey, entry.name, 'env'], undefined, { formattingOptions: fmt }));
      }
      rewrittenServers.push({ name: entry.name, realUrl: 'stdio:', from: 'stdio', to: proxyUrl });
      continue;
    }
    const realUrl = entry.url;;
    if (isProxyUrl(realUrl)) {
      alreadyWired.push(entry.name);
      continue;
    }

    const proxyUrl = `http://127.0.0.1:${PROXY_HTTP_PORT}/${encodeURIComponent(entry.name)}`;
    const existing = db
      .prepare('SELECT headers FROM mcp_servers WHERE name = ?')
      .get(entry.name) as { headers: string | null } | undefined;
    const { headersJson, authInjected: newAuth } = registerServerDestination(entry, existing);
    if (newAuth) authInjected.push(entry.name);

    db.prepare(`
      INSERT INTO mcp_servers (name, type, url, headers, connected, last_check)
      VALUES (?, 'http', ?, ?, 1, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        type = 'http', url = excluded.url, headers = excluded.headers,
        connected = 1, last_check = datetime('now')
    `).run(entry.name, realUrl, headersJson);

    text = applyEdits(text, modify(text, [containerKey, entry.name, 'url'], proxyUrl, { formattingOptions: fmt }));
    text = applyEdits(text, modify(text, [containerKey, entry.name, 'oauth'], undefined, { formattingOptions: fmt }));
    rewrittenServers.push({ name: entry.name, realUrl, from: realUrl, to: proxyUrl });
  }

  if (rewrittenServers.length > 0) {
    writeFileSync(row.config_path, text);
    noteSelfWrite(row.config_path);
  }

  console.log(
    `[protect] ${type}: sync — ${rewrittenServers.length} late-added server(s) rewired to ${proxyUrlHost()}, ${alreadyWired.length} already wired`,
  );
  return {
    type,
    configPath: row.config_path,
    backupPath: row.backup_path,
    rewrittenServers,
    authInjected,
    alreadyWired,
  };
}

export interface UnprotectResult {
  type: string;
  configPath: string;
  restoredBytes: boolean;
  hashMatched: boolean;
}

/** Restore the agent's original config from the backup, byte-for-byte, and
 *  clear the protection record. Throws if the backup is missing or does not
 *  match the recorded hash (a tampered backup is never written back). */
export function unprotectAgent(type: string): UnprotectResult {
  const row = db
    .prepare('SELECT config_path, backup_path, original_hash, original_headers FROM protected_agents WHERE type = ?')
    .get(type) as { config_path: string; backup_path: string; original_hash: string; original_headers: string | null } | undefined;
  if (!row) throw new Error(`Agent "${type}" is not protected`);

  const backup = readFileSync(row.backup_path, 'utf-8');
  const hashMatched = sha256Of(backup) === row.original_hash;
  if (!hashMatched) {
    throw new Error(`Backup ${row.backup_path} does not match the recorded original hash — refusing to restore a tampered file`);
  }

  writeFileSync(row.config_path, backup);
  noteSelfWrite(row.config_path);
  unlinkSync(row.backup_path);

  // Restore any mcp_servers.headers values we injected at protect time.
  const originalHeaders = JSON.parse(row.original_headers ?? '{}') as Record<string, string | null>;
  const stmt = db.prepare('UPDATE mcp_servers SET headers = ? WHERE name = ?');
  for (const [name, previous] of Object.entries(originalHeaders)) {
    stmt.run(previous, name);
  }

  db.prepare('DELETE FROM protected_agents WHERE type = ?').run(type);
  console.log(`[protect] ${type}: config restored from backup (hash ${hashMatched ? 'matched' : 'MISMATCH'})`);
  return { type, configPath: row.config_path, restoredBytes: true, hashMatched };
}

export function getProtectedAgents(): {
  type: string;
  configPath: string;
  backupPath: string;
  protectedAt: string;
}[] {
  return db
    .prepare('SELECT type, config_path as configPath, backup_path as backupPath, protected_at as protectedAt FROM protected_agents ORDER BY protected_at DESC')
    .all() as { type: string; configPath: string; backupPath: string; protectedAt: string }[];
}

export function isProtected(type: string): boolean {
  return !!db.prepare('SELECT type FROM protected_agents WHERE type = ?').get(type);
}

/** Auto-heal self-loop registrations: an mcp_servers row whose type='http'
 *  and url points at the proxy's OWN HTTP ingress (http://127.0.0.1:3002/x)
 *  would make the proxy fetch itself and fail forever ("Upstream MCP server
 *  unreachable: fetch failed"). Such rows arise when a config entry was
 *  registered as HTTP with the ingress URL instead of being re-wired from
 *  the real destination. Recovery looks up the ORIGINAL entry in each
 *  protected agent's backup (which holds the real command/URL from before
 *  the rewrite) and re-registers it as a stdio/http row. Also recreates rows
 *  that are MISSING from the DB while the live config already points at the
 *  proxy (e.g. after a data wipe) — the backup holds the real destination.
 *  Returns names that were healed/created (for spawning + tool sync). */
export function healSelfLoopRows(): string[] {
  const healed = new Set<string>();
  const backupEntries = readProtectedBackups();

  // 1) Heal rows in the DB that point at our own ingress.
  const rows = db
    .prepare("SELECT name, type, url FROM mcp_servers WHERE type = 'http' AND url IS NOT NULL")
    .all() as { name: string; type: string; url: string }[];

  for (const row of rows) {
    if (!isProxyIngressUrl(row.url)) continue;

    const original = backupEntries.get(row.name);
    if (original?.command) {
      registerStdioServer({ name: row.name, command: original.command, args: original.args, env: original.env });
      console.log(`[heal] ${row.name}: self-loop HTTP row recovered as stdio from backup`);
      healed.add(row.name);
    } else if (original?.url && !isProxyIngressUrl(original.url)) {
      db.prepare("UPDATE mcp_servers SET url = ? WHERE name = ?").run(original.url, row.name);
      db.prepare("UPDATE mcp_servers SET connected = ?, last_check = datetime('now') WHERE name = ?").run(0, row.name);
      console.log(`[heal] ${row.name}: self-loop row repointed to real URL ${original.url}`);
      healed.add(row.name);
    } else {
      // Nothing to recover from — mark failed so the UI shows the error
      // instead of an infinite "fetch failed" loop.
      db.prepare("UPDATE mcp_servers SET connected = 0 WHERE name = ?").run(row.name);
    }
  }

  // 2) Recreate rows that are missing while a protected agent's live config
  //    already points that entry at our ingress (config was rewired, but the
  //    row was deleted / DB wiped). Rebuild from the backup's real entry.
  for (const [name, original] of backupEntries) {
    const missing = !db.prepare('SELECT name FROM mcp_servers WHERE name = ?').get(name);
    if (!missing) continue;
    const liveWired = protectedEntryAtProxy(name);
    if (!liveWired) continue;

    if (original.command) {
      registerStdioServer({ name, command: original.command, args: original.args, env: original.env });
      console.log(`[heal] ${name}: missing row recreated as stdio from backup`);
      healed.add(name);
    } else if (original.url && !isProxyIngressUrl(original.url)) {
      db.prepare(`
        INSERT INTO mcp_servers (name, type, url, connected, last_check)
        VALUES (?, 'http', ?, 0, datetime('now'))
      `).run(name, original.url);
      healed.add(name);
    }
  }

  return [...healed];
}

/** Map every server name in every protected agent's backup to its ORIGINAL
 *  (pre-rewrite) entry — the real command / real URL. */
function readProtectedBackups(): Map<string, McpEntry> {
  const out = new Map<string, McpEntry>();
  for (const { backupPath } of getProtectedAgents()) {
    if (!existsSync(backupPath)) continue;
    try {
      const { entries } = parseConfigFile(backupPath);
      for (const [name, entry] of entries) {
        if (!out.has(name)) out.set(name, entry);
      }
    } catch { /* unreadable backup — try the next agent */ }
  }
  return out;
}

/** True when any protected agent's CURRENT config already points `name` at
 *  the proxy ingress (i.e. the entry was rewired but has no DB row). */
function protectedEntryAtProxy(name: string): boolean {
  for (const { configPath } of getProtectedAgents()) {
    if (!existsSync(configPath)) continue;
    try {
      const { entries } = parseConfigFile(configPath);
      const entry = entries.get(name);
      if (entry?.url && isProxyIngressUrl(entry.url)) return true;
    } catch { /* continue */ }
  }
  return false;
}

/** Reverse the protect rewrite for ONE server entry in an agent's config:
 *  replace the proxy ingress URL with the connector's real URL (from
 *  mcp_servers), leaving every other entry untouched. Used by the connector
 *  page's unbind action — the agent stays protected, only this server's
 *  traffic stops flowing through the firewall. Throws if the entry is not
 *  currently pointed at the proxy. */
export function unbindServerFromAgent(type: string, serverName: string): void {
  const row = db
    .prepare('SELECT config_path FROM protected_agents WHERE type = ?')
    .get(type) as { config_path: string } | undefined;

  let configPath = row?.config_path;
  if (!configPath || !existsSync(configPath)) {
    const candidate = AGENT_PATHS.find(
      (p) => p.type.toLowerCase() === type.toLowerCase() ||
             p.name.toLowerCase().includes(type.toLowerCase()) ||
             type.toLowerCase().includes(p.type.toLowerCase())
    );
    if (candidate && existsSync(candidate.path)) {
      configPath = candidate.path;
    }
  }

  if (!configPath || !existsSync(configPath)) {
    console.log(`[protect] ${type}: no existing config file found for unbind`);
    return;
  }

  const serverRow = db
    .prepare('SELECT name, type, url, command, args, env FROM mcp_servers WHERE name = ?')
    .get(serverName) as {
      name: string;
      type: string;
      url: string | null;
      command: string | null;
      args: string | null;
      env: string | null;
    } | undefined;

  const { raw, containerKey, entries } = parseConfigFile(configPath);
  const entry = entries.get(serverName);
  if (!entry) {
    console.log(`[protect] ${type}: entry "${serverName}" not in config — nothing to unbind`);
    return;
  }

  const isOpencode = /opencode/i.test(configPath) || containerKey === 'mcp';
  const isCline = /cline/i.test(configPath);
  const fmt = { insertSpaces: true, tabSize: 2, eol: raw.includes('\r\n') ? '\r\n' : '\n' };

  let edits;
  if (serverRow?.url && !isProxyIngressUrl(serverRow.url)) {
    // Restore real external URL
    edits = modify(raw, [containerKey, serverName, 'url'], serverRow.url, { formattingOptions: fmt });
  } else if (serverRow?.command) {
    // Restore stdio command
    let args: string[] = [];
    try { args = serverRow.args ? (JSON.parse(serverRow.args) as string[]) : []; } catch { /* ignore */ }
    let envObj: Record<string, string> = {};
    try { envObj = serverRow.env ? (JSON.parse(serverRow.env) as Record<string, string>) : {}; } catch { /* ignore */ }

    let stdioVal: Record<string, unknown>;
    if (isOpencode) {
      stdioVal = {
        type: 'local',
        enabled: true,
        command: [serverRow.command, ...args],
        ...(Object.keys(envObj).length > 0 ? { environment: envObj } : {}),
      };
    } else if (isCline) {
      stdioVal = {
        command: serverRow.command,
        args,
        ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}),
        disabled: false,
      };
    } else {
      stdioVal = {
        command: serverRow.command,
        args,
        ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}),
      };
    }
    edits = modify(raw, [containerKey, serverName], stdioVal, { formattingOptions: fmt });
  } else {
    // Mock server or no external destination: remove from agent config
    edits = modify(raw, [containerKey, serverName], undefined, { formattingOptions: fmt });
  }

  const text = applyEdits(raw, edits);
  writeFileSync(configPath, text);
  noteSelfWrite(configPath);
  console.log(`[protect] ${type}: entry "${serverName}" successfully unbound from ${configPath}`);
}
