import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join, basename, dirname, normalize, win32 } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import db from '../db/index.js';
import { parseJsoncConfig } from './config-fetch.js';
import { getAgentPathDescriptors } from './adapters/registry.js';

// The HTTP MCP ingress URL prefix (proxy.ts: PROXY_HTTP_PORT). Entries whose
// url points here are already flowing through the firewall — auto-registration
// must not clobber them (rewriter.ts may have converted them to stdio rows).
const PROXY_INGRESS_PORTS = new Set([process.env.CF_PROXY_HTTP_PORT || '3002']);

export function isProxyIngressUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return PROXY_INGRESS_PORTS.has(u.port || (u.protocol === 'https:' ? '443' : '80'));
  } catch {
    return false;
  }
}

/**
 * Read an agent MCP config file. Agent configs are JSON except opencode's
 * opencode.jsonc (comments + trailing commas allowed). The JSONC parser is
 * the single source of truth (config-fetch.ts): it strips the BOM, collects
 * parse errors, tolerates comments/trailing commas and NEVER throws — a
 * missing, empty or malformed file returns null for the caller to skip.
 */
function readAgentConfig(configPath: string): McpConfig | null {
  try {
    // A config that is a directory (Cline CLI's ~/.cline/data) has no JSON to
    // read — return an empty object so every caller treats it as a detected
    // agent with no flat-file MCP entries (and never warns "unreadable").
    if (statSync(configPath).isDirectory()) return {};
    const raw = readFileSync(configPath, 'utf-8');
    return parseJsoncConfig(raw) as McpConfig | null;
  } catch {
    return null;
  }
}

function stableId(...parts: string[]): string {
  return createHash('md5').update(parts.join('|')).digest('hex');
}

export interface DailyUsage {
  day: string;
  tokens: number;
  input?: number;
  output?: number;
}

export interface HourlyUsage {
  hour: number;
  tokens: number;
}

export interface AgentStats {
  sessions?: number;
  conversations?: number;
  messages?: number;
  /** Agent-turn steps (agy conversation_summaries step_count sum). */
  steps?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  tokensReasoning?: number;
  cost?: number;
  models?: string[];
  modelUsage?: { model: string; tokens: number; sessions: number }[];
  installDate?: string;
  lastActive?: string;
  configFiles?: number;
  dotEnvReads?: number;
  dailyUsage?: DailyUsage[];
  last24h?: HourlyUsage[];
  // Proxy traffic (P11): totals over the agent's audited calls, attributed by
  // the client-declared identity (clientInfo.name). Always present for
  // detected agents — zero, never undefined — and durable across restarts
  // (audit_log is SQLite). Blocked counts policy denies; logged is log-only.
  proxyCalls?: number;
  proxyAllowed?: number;
  proxyBlocked?: number;
  proxyLogged?: number;
}

export interface McpServerInfo {
  name: string;
  type: string;
  url?: string;
  command?: string;
}

export interface DetectedAgent {
  id: string;
  name: string;
  type: string;
  configPath?: string;
  dataPath?: string;
  iconPath?: string;
  firstSeen: string;
  lastSeen: string;
  status: 'active' | 'inactive';
  stats?: AgentStats;
  mcpServers?: McpServerInfo[];
  mcpCount?: number;
  directoryContents?: string[];
  // P12: honest protection status — is this agent's config actually rewired
  // so its real MCP traffic flows through Context Fence? False means the
  // agent is visible to detection but its traffic still bypasses the proxy.
  protected?: boolean;
  protectedAt?: string;
  backupPath?: string;
  // Does the backup file still exist on disk? The UI only offers "Restore"
  // when it does — restoring byte-for-byte is impossible without it.
  backupExists?: boolean;
}

function protectionInfoFor(type: string): { protected: boolean; protectedAt?: string; backupPath?: string; backupExists?: boolean } {
  try {
    const row = db
      .prepare('SELECT backup_path, protected_at FROM protected_agents WHERE type = ?')
      .get(type) as { backup_path: string; protected_at: string } | undefined;
    if (!row) return { protected: false };
    let backupExists = false;
    try {
      backupExists = existsSync(row.backup_path);
    } catch {
      backupExists = false;
    }
    return { protected: true, protectedAt: row.protected_at, backupPath: row.backup_path, backupExists };
  } catch {
    return { protected: false };
  }
}

interface McpConfig {
  mcpServers?: Record<string, UnknownServerEntry>;
  mcp?: Record<string, UnknownServerEntry>;
}

// Raw agent-declared MCP server entry. Covers claude/cursor/continue (string
// command + args[]) AND opencode (command as an array, optional type/enabled).
interface UnknownServerEntry {
  type?: string;
  enabled?: boolean;
  command?: string | string[];
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, unknown>;
  [k: string]: unknown;
}

// Normalized entry used everywhere downstream (detection, import, scan):
// direction-of-travel resolved once, transport derived from the presence of a
// url, opencode command arrays split into command + args.
interface NormalizedServerEntry {
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, unknown>;
}

function normalizeServerEntry(raw: UnknownServerEntry | undefined): NormalizedServerEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.enabled === false) return null;
  const url = typeof raw.url === 'string' && raw.url ? raw.url : undefined;

  let command: string | undefined;
  let args: string[] | undefined;
  const cmd = raw.command;
  if (typeof cmd === 'string') {
    command = cmd;
    args = Array.isArray(raw.args) ? raw.args.map(String) : undefined;
  } else if (Array.isArray(cmd) && cmd.length > 0) {
    command = String(cmd[0]);
    args = cmd.slice(1).map((a) => String(a));
  }

  const env = raw.env && typeof raw.env === 'object'
    ? Object.fromEntries(Object.entries(raw.env).filter(([, v]) => v !== undefined && v !== null)) as Record<string, string>
    : undefined;
  const headers = raw.headers && typeof raw.headers === 'object'
    ? raw.headers as Record<string, unknown>
    : undefined;

  const normalized: NormalizedServerEntry = { type: url ? 'http' : 'stdio', url, command, args, env, headers };

  // A `type: local` opencode entry with no url is still stdio; a url entry is
  // http regardless of what the agent labels it. None of that affects the
  // normalized shape — but entries with neither url nor command are unusable.
  if (!url && !command) return null;

  return normalized;
}

function serverContainer(config: McpConfig): Record<string, UnknownServerEntry> {
  return config.mcpServers || config.mcp || {};
}

const isWindows = process.platform === 'win32';

// Agent metadata (dataPath, icon) is layered over the canonical scan list in
// the adapter registry itself (adapters/core.ts MASTER_PATH_SPECS) — the path
// list, display metadata and fetch pipeline can never drift apart. Order is
// preserved (first existing config per type wins as the agent's primary).
// Project-local .mcp.json is scanned + watched by the registry but was never
// a detected-agent row, so `agent: false` descriptors are filtered out here.
export const AGENT_PATHS: { path: string; dataPath?: string; name: string; type: string; icon?: string }[] =
  getAgentPathDescriptors()
    .filter((d) => d.agent)
    .map((d) => ({
      path: d.path,
      name: d.name,
      type: d.type,
      ...(d.icon ? { icon: d.icon } : {}),
      ...(d.dataPath ? { dataPath: d.dataPath } : {}),
    }));

// Read-only query into ANOTHER app's SQLite database (opencode.db, codex
// state_5.sqlite). Previously shelled out to the `sqlite3` CLI, which does not
// exist on Windows (and is not guaranteed anywhere) — every agent stat came
// back empty there. better-sqlite3 is bundled with Context Fence itself, so
// this works on every platform. Read-only + short timeout so a DB that is
// actively being written by the agent never blocks or corrupts anything.
function queryDb(dbPath: string, sql: string): unknown[][] {
  try {
    if (!existsSync(dbPath)) return [];
    const dbh = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 2000 });
    try {
      // .all() returns row objects; callers destructure positionally, so map
      // to plain value arrays (same shape the old sqlite3 CLI produced).
      return (dbh.prepare(sql).all() as Record<string, unknown>[]).map((r) =>
        Object.values(r).map((v) => (typeof v === 'bigint' ? Number(v) : v)),
      );
    } finally {
      dbh.close();
    }
  } catch { return []; }
}

function readJsonl(path: string): Record<string, unknown>[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function parseClaudeStats(agent: { path: string; dataPath?: string }): AgentStats {
  const stats: AgentStats = {};
  const dataPath = agent.dataPath || dirname(agent.path);

  const history = readJsonl(join(dataPath, 'history.jsonl'));
  stats.conversations = history.length;

  const projectsDir = join(dataPath, 'projects');
  if (existsSync(projectsDir)) {
    try {
      const sessions = readdirSync(projectsDir).filter(f => f.endsWith('.jsonl'));
      stats.sessions = sessions.length;
    } catch { stats.sessions = 0; }
  }

  try {
    const s = statSync(dataPath);
    stats.installDate = new Date(s.birthtime).toISOString();
    stats.lastActive = new Date(s.mtime).toISOString();
  } catch {}

  stats.configFiles = 1;
  if (existsSync(join(dataPath, 'settings.json'))) stats.configFiles!++;
  if (existsSync(join(dataPath, 'policy-limits.json'))) stats.configFiles!++;

  return stats;
}

function parseOpencodeStats(agent: { path: string; dataPath?: string }): AgentStats {
  const stats: AgentStats = {};
  const dataPath = agent.dataPath;
  if (!dataPath || !existsSync(dataPath)) return stats;

  // Guard: skip malformed timestamps
function safeTimestamp(ts: any): number { const n = Number(ts); return isNaN(n) ? 0 : n; }

const dbFile = join(dataPath, 'opencode.db');
  if (!existsSync(dbFile)) return stats;

  const sessionRows = queryDb(dbFile, "SELECT COUNT(*), COALESCE(SUM(tokens_input),0), COALESCE(SUM(tokens_output),0), COALESCE(SUM(tokens_reasoning),0), COALESCE(MIN(time_created),0), COALESCE(MAX(time_updated),0) FROM session");
  if (sessionRows.length) {
    const [count, input, output, reasoning, first, last] = sessionRows[0];
    stats.sessions = count as number;
    stats.tokensInput = input as number;
    stats.tokensOutput = output as number;
    stats.tokensReasoning = reasoning as number;
    stats.tokensTotal = (input as number) + (output as number) + (reasoning as number);
    stats.installDate = new Date(first as number).toISOString();
    stats.lastActive = new Date(last as number).toISOString();
  }

  const msgRows = queryDb(dbFile, "SELECT COUNT(*) FROM message");
  if (msgRows.length) stats.messages = msgRows[0][0] as number;

  // Real per-model distribution: model JSON column ({"id":...,"variant":...})
  // grouped with session + token aggregates, deduped by parsed id so
  // variant-split rows roll up into one model slice.
  const modelRows = queryDb(dbFile, "SELECT model, COUNT(*), COALESCE(SUM(tokens_input),0)+COALESCE(SUM(tokens_output),0)+COALESCE(SUM(tokens_reasoning),0) FROM session WHERE model IS NOT NULL GROUP BY model");
  if (modelRows.length) {
    const byId = new Map<string, { tokens: number; sessions: number }>();
    for (const row of modelRows) {
      const [raw, count, tokens] = row;
      let id = String(raw);
      try { id = JSON.parse(id)?.id || id; } catch { /* keep raw */ }
      const prev = byId.get(id) || { tokens: 0, sessions: 0 };
      byId.set(id, {
        tokens: prev.tokens + (tokens as number),
        sessions: prev.sessions + (count as number),
      });
    }
    stats.models = [...byId.keys()];
    stats.modelUsage = [...byId.entries()].map(([model, v]) => ({ model, tokens: v.tokens, sessions: v.sessions }));
  }

  stats.configFiles = 1;
  if (existsSync(join(dirname(dataPath), 'opencode.jsonc'))) stats.configFiles!++;

  const dailyRows = queryDb(dbFile, "SELECT date(time_created/1000,'unixepoch') as day, SUM(tokens_input), SUM(tokens_output) FROM session GROUP BY day ORDER BY day");
  if (dailyRows.length) {
    stats.dailyUsage = dailyRows.map(r => {
      const [day, input, output] = r;
      return { day: day as string, tokens: (input as number) + (output as number), input: input as number, output: output as number };
    });
  }

  const hourlyRows = queryDb(dbFile, "SELECT CAST(strftime('%H', time_created/1000, 'unixepoch', 'localtime') AS INTEGER)/2*2 as slot, SUM(tokens_input)+SUM(tokens_output) FROM session WHERE time_created/1000 >= CAST(strftime('%s','now','-24 hours') AS INTEGER) GROUP BY slot ORDER BY slot");
  const slots: HourlyUsage[] = [];
  const currentSlot = Math.round(new Date().getHours() / 2) * 2;
  for (let i = 11; i >= 0; i--) {
    const slot = ((currentSlot - i * 2) % 24 + 24) % 24;
    const match = hourlyRows.find((r: unknown[]) => r[0] === slot);
    slots.push({ hour: slot, tokens: match ? (match[1] as number) : 0 });
  }
  stats.last24h = slots;

  return stats;
}

function parseCodexStats(agent: { path: string; dataPath?: string }): AgentStats {
  const stats: AgentStats = {};
  const dataPath = agent.dataPath || dirname(agent.path);
  if (!existsSync(dataPath)) return stats;

  const stateDb = join(dataPath, 'state_5.sqlite');
  if (existsSync(stateDb)) {
    const rows = queryDb(stateDb, "SELECT COUNT(*), COALESCE(SUM(tokens_used),0), MIN(created_at), MAX(updated_at), COUNT(DISTINCT model) FROM threads");
    if (rows.length) {
      const [count, tokens, first, last, models] = rows[0];
      stats.sessions = count as number;
      stats.tokensTotal = tokens as number;
      // Real per-model distribution from the threads table — replaces the
      // previously hardcoded model list.
      const modelRows = queryDb(stateDb, "SELECT model, COUNT(*), COALESCE(SUM(tokens_used),0) FROM threads WHERE model IS NOT NULL GROUP BY model");
      if (modelRows.length) {
        stats.models = modelRows.map(r => String(r[0]));
        stats.modelUsage = modelRows.map(r => ({ model: String(r[0]), tokens: r[2] as number, sessions: r[1] as number }));
      }
      stats.installDate = new Date((first as number) * 1000).toISOString();
      stats.lastActive = new Date((last as number) * 1000).toISOString();
    }
  }

  const sessions = readJsonl(join(dataPath, 'session_index.jsonl'));
  stats.conversations = sessions.length;

  stats.configFiles = 1;
  for (const f of ['config.toml', 'auth.json', 'models_cache.json']) {
    if (existsSync(join(dataPath, f))) stats.configFiles!++;
  }

  const dailyRows = queryDb(stateDb, "SELECT date(created_at,'unixepoch') as day, SUM(tokens_used) FROM threads GROUP BY day ORDER BY day");
  if (dailyRows.length) {
    stats.dailyUsage = dailyRows.map(r => {
      const [day, tokens] = r;
      return { day: day as string, tokens: tokens as number };
    });
  }

  const hourlyRows = queryDb(stateDb, "SELECT CAST(strftime('%H', created_at, 'unixepoch', 'localtime') AS INTEGER)/2*2 as slot, SUM(tokens_used) FROM threads WHERE created_at >= CAST(strftime('%s','now','-24 hours') AS INTEGER) GROUP BY slot ORDER BY slot");
  const slots: HourlyUsage[] = [];
  const currentSlot = Math.round(new Date().getHours() / 2) * 2;
  for (let i = 11; i >= 0; i--) {
    const slot = ((currentSlot - i * 2) % 24 + 24) % 24;
    const match = hourlyRows.find((r: unknown[]) => r[0] === slot);
    slots.push({ hour: slot, tokens: match ? (match[1] as number) : 0 });
  }
  stats.last24h = slots;

  return stats;
}

function parseCopilotStats(agent: { path: string; dataPath?: string }): AgentStats {
  const stats: AgentStats = {};
  const dataPath = agent.dataPath || dirname(agent.path);
  if (!existsSync(dataPath)) return stats;

  try {
    const s = statSync(dataPath);
    stats.lastActive = new Date(s.mtime).toISOString();
    stats.installDate = new Date(s.birthtime).toISOString();
  } catch {}

  stats.configFiles = 1;
  for (const f of ['config.json', 'apps.json']) {
    if (existsSync(join(dataPath, f))) stats.configFiles!++;
  }

  return stats;
}
// Cline CLI stats. The current Cline CLI keeps everything under
// ~/.cline/data: session records (model, provider, started_at, and a
// metadata_json blob that carries per-session token usage + cost) live in
// db/sessions.db, and each session's transcript lives in
// sessions/<id>/<id>.messages.json. This mirrors the OpenCode parser field
// by field so the AgentDetail page renders the same full stat set
// (sessions, tokens, model distribution, daily + last-24h usage, install &
// last-active dates).
function parseClineStats(agent: { path: string; dataPath?: string }): AgentStats {
  const stats: AgentStats = {};
  // Cline CLI keeps everything under ~/.cline/data regardless of which AGENT_PATHS
  // entry matched (the VS Code-extension cline_mcp_settings.json also maps to
  // type 'cline' with no dataPath), so resolve the canonical root from the home
  // dir rather than trusting agent.dataPath/path.
  const sessionsDb = join(homedir(), '.cline', 'data', 'db', 'sessions.db');
  if (!existsSync(sessionsDb)) return stats;

  const toMs = (iso: unknown): number => {
    if (typeof iso !== 'string') return 0;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  };

  const sessionRows = queryDb(
    sessionsDb,
    "SELECT model, started_at, metadata_json FROM sessions ORDER BY started_at",
  ) as unknown[][];

  if (sessionRows.length === 0) return stats;

  const firstMs = toMs(sessionRows[0]?.[1]);
  const lastMs = toMs(sessionRows[sessionRows.length - 1]?.[1]);
  if (firstMs) stats.installDate = new Date(firstMs).toISOString();
  if (lastMs) stats.lastActive = new Date(lastMs).toISOString();

  stats.sessions = sessionRows.length;
  stats.configFiles = 1;
  const clineRoot = join(homedir(), '.cline');
  if (existsSync(join(clineRoot, 'data', 'settings', 'providers.json'))) stats.configFiles!++;
  if (existsSync(join(clineRoot, 'data', 'settings', 'global-settings.json'))) stats.configFiles!++;

  // Aggregate token usage + cost from each session's metadata usage blob.
  let input = 0, output = 0, reasoning = 0, cost = 0;
  const byModel = new Map<string, { tokens: number; sessions: number }>();
  for (const [model, _started, metaJson] of sessionRows) {
    const modelId = typeof model === 'string' && model ? model : 'unknown';
    const prev = byModel.get(modelId) || { tokens: 0, sessions: 0 };
    byModel.set(modelId, { tokens: prev.tokens, sessions: prev.sessions + 1 });

    let i = 0, o = 0, r = 0, mToken = 0;
    if (typeof metaJson === 'string' && metaJson) {
      try {
        const meta = JSON.parse(metaJson) as { usage?: Record<string, unknown>; totalCost?: number };
        const u = meta.usage;
        i = typeof u?.inputTokens === 'number' ? u.inputTokens : 0;
        o = typeof u?.outputTokens === 'number' ? u.outputTokens : 0;
        r = typeof u?.reasoningTokens === 'number' ? u.reasoningTokens : 0;
        mToken = typeof u?.totalTokens === 'number' ? u.totalTokens : i + o;
        if (typeof meta.totalCost === 'number') cost += meta.totalCost;
      } catch { /* malformed metadata — skip */ }
    }
    input += i; output += o; reasoning += r;
    const prevM = byModel.get(modelId)!;
    byModel.set(modelId, { tokens: prevM.tokens + mToken, sessions: prevM.sessions });
  }
  if (byModel.size > 0) {
    stats.models = [...byModel.keys()];
    stats.modelUsage = [...byModel.entries()].map(([model, v]) => ({ model, tokens: v.tokens, sessions: v.sessions }));
  }
  stats.tokensInput = input;
  stats.tokensOutput = output;
  stats.tokensReasoning = reasoning;
  stats.tokensTotal = input + output + reasoning;
  if (cost > 0) stats.cost = cost;

  // Message totals: count transcript USER messages across all session files.
  // We count only `role === 'user'` entries (the messages the person actually
  // sent), not every assistant turn / tool_result — the UI "Messages" figure
  // is meant to show user-sent messages, matching how the metric is labelled.
  let messages = 0;
  try {
    const msgRows = queryDb(sessionsDb, "SELECT messages_path FROM sessions WHERE messages_path IS NOT NULL AND messages_path != ''");
    for (const [mp] of msgRows as unknown[][]) {
      try {
        const raw = readFileSync(String(mp), 'utf-8');
        const doc = JSON.parse(raw) as { messages?: { role?: string }[] };
        if (Array.isArray(doc.messages)) {
          messages += doc.messages.filter((m) => m?.role === 'user').length;
        }
      } catch { /* unreadable transcript — skip */ }
    }
  } catch { /* ignore */ }
  if (messages > 0) stats.messages = messages;

  // Daily usage: group sessions by UTC day (ISO timestamps).
  const daily = new Map<string, { input: number; output: number }>();
  for (const row of sessionRows) {
    const ms = toMs(row[1]);
    if (!ms) continue;
    const day = new Date(ms).toISOString().slice(0, 10);
    const metaJson = row[2];
    let i = 0, o = 0;
    if (typeof metaJson === 'string' && metaJson) {
      try {
        const u = (JSON.parse(metaJson) as { usage?: Record<string, unknown> }).usage;
        i = typeof u?.inputTokens === 'number' ? u.inputTokens : 0;
        o = typeof u?.outputTokens === 'number' ? u.outputTokens : 0;
      } catch { /* ignore */ }
    }
    const cur = daily.get(day) || { input: 0, output: 0 };
    cur.input += i; cur.output += o;
    daily.set(day, cur);
  }
  if (daily.size > 0) {
    stats.dailyUsage = [...daily.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day, tokens: v.input + v.output, input: v.input, output: v.output }));
  }

  // Last-24h: 2-hour slots like the other parsers.
  const bySlot = new Map<number, number>();
  for (const row of sessionRows) {
    const ms = toMs(row[1]);
    if (!ms) continue;
    const slot = Math.round(new Date(ms).getHours() / 2) * 2;
    const metaJson = row[2];
    let t = 0;
    if (typeof metaJson === 'string' && metaJson) {
      try {
        const u = (JSON.parse(metaJson) as { usage?: Record<string, unknown> }).usage;
        const i = typeof u?.inputTokens === 'number' ? u.inputTokens : 0;
        const o = typeof u?.outputTokens === 'number' ? u.outputTokens : 0;
        t = i + o;
      } catch { /* ignore */ }
    }
    bySlot.set(slot, (bySlot.get(slot) || 0) + t);
  }
  const slotTicks = [...bySlot.entries()];
  const currentSlot = Math.round(new Date().getHours() / 2) * 2;
  const slots: HourlyUsage[] = [];
  for (let i = 11; i >= 0; i--) {
    const slot = ((currentSlot - i * 2) % 24 + 24) % 24;
    const match = slotTicks.find(([s]) => s === slot);
    slots.push({ hour: slot, tokens: match ? match[1] : 0 });
  }
  stats.last24h = slots;

  return stats;
}




// Gemini CLI (agy) stats. Everything Google meters server-side (tokens, cost)
// is simply absent — we surface ONLY what is stored locally:
//   - ~/.gemini/antigravity-cli/conversation_summaries.db: one row per
//     conversation with step_count, timestamps, workspace URIs
//   - ~/.gemini/antigravity-cli/settings.json: the selected model label
//   - ~/.gemini/config/: config + mcp_config.json files on disk
function parseGeminiStats(agent: { path: string; dataPath?: string }): AgentStats {
  const stats: AgentStats = {};
  const cliRoot = join(homedir(), '.gemini', 'antigravity-cli');
  const summariesDb = join(cliRoot, 'conversation_summaries.db');
  if (!existsSync(summariesDb)) return stats;

  // Local ISO strings look like `2026-05-06 21:04:58.773601+00:00` — swap the
  // space for `T` so Date.parse() accepts them. Zero-dates (0001-01-01 —
  // conversations that never saw user input) are discarded.
  const toIso = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string' || !raw) return undefined;
    const t = Date.parse(raw.replace(' ', 'T'));
    if (Number.isNaN(t) || t < Date.parse('2000-01-01T00:00:00Z')) return undefined;
    return new Date(t).toISOString();
  };

  const rows = queryDb(
    summariesDb,
    "SELECT COUNT(*), COALESCE(SUM(step_count),0), MIN(last_user_input_time), MAX(last_modified_time) FROM conversation_summaries",
  ) as unknown[][];
  if (rows.length) {
    const [count, steps, first, last] = rows[0];
    stats.sessions = count as number;
    stats.conversations = count as number;
    stats.steps = steps as number;
    const installed = toIso(first);
    const lastActive = toIso(last);
    // No valid conversation timestamps → fall back to the data dir's birthday.
    if (installed) {
      stats.installDate = installed;
    } else {
      try {
        stats.installDate = new Date(statSync(join(homedir(), '.gemini')).birthtime).toISOString();
      } catch { /* optional */ }
    }
    if (lastActive) stats.lastActive = lastActive;
  }

  // Daily activity in agent STEPS (not tokens — those never touch the disk).
  try {
    const dailyRows = queryDb(
      summariesDb,
      "SELECT date(last_modified_time) as day, SUM(step_count) FROM conversation_summaries GROUP BY day ORDER BY day",
    ) as unknown[][];
    if (dailyRows.length) {
      stats.dailyUsage = dailyRows
        .filter((r) => typeof r[0] === 'string')
        .map((r) => ({ day: String(r[0]), tokens: r[1] as number }));
    }
  } catch { /* optional */ }

  // Selected model from the CLI's own settings file.
  try {
    const settingsPath = join(cliRoot, 'settings.json');
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { model?: unknown };
      if (typeof parsed.model === 'string' && parsed.model.trim()) {
        stats.models = [parsed.model.trim()];
      }
    }
  } catch { /* unreadable settings */ }

  stats.configFiles = 1;
  if (existsSync(join(homedir(), '.gemini', 'config', 'mcp_config.json'))) stats.configFiles!++;
  if (existsSync(join(homedir(), '.gemini', 'config', 'config.json'))) stats.configFiles!++;

  return stats;
}

const STATS_PARSERS: Record<string, (agent: { path: string; dataPath?: string }) => AgentStats> = {
  claude: parseClaudeStats,
  opencode: parseOpencodeStats,
  codex: parseCodexStats,
  copilot: parseCopilotStats,
  cline: parseClineStats,
  gemini: parseGeminiStats,
};

// Cline CLI keeps its MCP connectors in a SQLite DB (~/.cline/data/db/
// connectors.db), not in a JSON config file. The DB has two tables:
//   connector_configs      (channel, type, values_json)
//   connector_connections  (channel, instance_id, connect_args_json, enabled)
// Best-effort read-only parse — returns [] if the DB is missing/unreadable/
// empty so the caller never surfaces a broken connector list.
function readClineCliServers(dataDir: string): McpServerInfo[] {
  const dbPath = join(dataDir, 'db', 'connectors.db');
  if (!existsSync(dbPath)) return [];
  const servers: McpServerInfo[] = [];
  try {
    const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = conn
        .prepare(
          `SELECT cc.channel AS channel, cc.type AS ctype, cc.values_json AS values_json,
                  cj.instance_id AS instance_id, cj.connect_args_json AS connect_args_json,
                  cj.enabled AS enabled
           FROM connector_configs cc
           LEFT JOIN connector_connections cj ON cj.channel = cc.channel`,
        )
        .all() as {
        channel: string;
        ctype: string;
        values_json: string;
        instance_id: string;
        connect_args_json: string;
        enabled: number;
      }[];
      for (const r of rows) {
        if (r.enabled === 0) continue;
        try {
          const vals = JSON.parse(r.values_json || '{}') as Record<string, unknown>;
          const args = JSON.parse(r.connect_args_json || '{}') as Record<string, unknown>;
          const name = String(vals.name || r.instance_id || r.channel || 'mcp');
          const url = typeof vals.url === 'string' ? vals.url : typeof args.url === 'string' ? args.url : undefined;
          const command = Array.isArray(args.command)
            ? args.command.map(String)
            : typeof args.command === 'string' && args.command.trim()
              ? [args.command]
              : [];
          if (!url && command.length === 0) continue;
          servers.push({
            name,
            type: (typeof vals.type === 'string' && vals.type) || (url ? 'http' : 'local'),
            ...(url ? { url } : {}),
            ...(command.length ? { command: command[0] } : {}),
          });
        } catch { /* malformed row — skip */ }
      }
    } finally {
      try { conn.close(); } catch { /* ignore */ }
    }
  } catch { /* unreadable DB — treat as no connectors */ }
  return servers;
}

function isClineDataDir(configPath: string): boolean {
  return basename(configPath) === 'data' && /[\\/]\.cline[\\/]data$/.test(configPath.replace(/[\\/]+$/, ''));
}

function readMcpServers(configPath: string, agentType?: string): McpServerInfo[] {
  // Cline CLI: connectors live in a SQLite DB under ~/.cline/data.
  if (agentType === 'cline' && isClineDataDir(configPath)) {
    return readClineCliServers(configPath);
  }
  const config = readAgentConfig(configPath);
  if (!config) return [];
  const servers = serverContainer(config);
  return Object.entries(servers)
    .map(([name, s]) => {
      const n = normalizeServerEntry(s);
      return n ? { name, type: n.type, url: n.url, command: n.command } : null;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
}

// ── Connector-level detection (N1: connector management) ────────────────────
// Extension of the agent-presence scan: for every detected agent config that
// declares MCP servers, extract the FULL entry (transport, url/command, args,
// env keys, header keys) so the UI can surface "detected, not yet imported"
// connectors with one-click import. SECURITY: env/header VALUES are never
// returned — only key names and whether a value is present. Import performs
// the write server-side, so values never transit the API.
export interface DetectedConnectorConfig {
  name: string;
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  envKeys: string[];
  envSet: boolean;
  headerKeys: string[];
  headersSet: boolean;
}

export interface DetectedConnectorsForAgent {
  agentType: string;
  agentName: string;
  configPath: string;
  connectors: DetectedConnectorConfig[];
}

function stripSecretKeys(entries: Record<string, unknown> | undefined): string[] {
  if (!entries) return [];
  return Object.keys(entries);
}

export function detectMcpConnectors(): DetectedConnectorsForAgent[] {
  const out: DetectedConnectorsForAgent[] = [];
  for (const ap of AGENT_PATHS) {
    if (!existsSync(ap.path)) continue;
    if (out.some((a) => a.agentType === ap.type)) continue;
    const config = readAgentConfig(ap.path);
    if (!config) continue;
    const servers = serverContainer(config);
    if (Object.keys(servers).length === 0) continue;
    const connectors: DetectedConnectorConfig[] = Object.entries(servers)
      .map(([name, s]) => {
        const n = normalizeServerEntry(s);
        if (!n) return null;
        return {
          name,
          type: n.type,
          url: n.url,
          command: n.command,
          args: n.args,
          envKeys: stripSecretKeys(n.env),
          envSet: !!n.env && Object.keys(n.env).length > 0,
          headerKeys: n.headers ? stripSecretKeys(n.headers).filter((k) => k !== 'oauth') : [],
          headersSet: !!n.headers && Object.keys(n.headers).length > 0,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    if (connectors.length === 0) continue;
    out.push({ agentType: ap.type, agentName: ap.name, configPath: ap.path, connectors });
  }
  return out;
}

/**
 * Full connector entry for IMPORT (server-side write path only — values never
 * cross the API). Reads the raw entry the agent declares for `serverName` in
 * its config: transport, url/command, args, env (values), and auth headers
 * (Authorization carried over; `oauth` blocks are never copied — the proxy
 * mints its own tokens).
 */
export function getConnectorConfigForImport(agentType: string, serverName: string): {
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
} | null {
  const ap = AGENT_PATHS.find((a) => a.type === agentType);
  if (!ap || !existsSync(ap.path)) return null;
  const config = readAgentConfig(ap.path);
  if (!config) return null;
  const servers = serverContainer(config);
  const s = servers[serverName];
  const n = normalizeServerEntry(s);
  if (!n) return null;

  const env: Record<string, string> = {};
  if (n.env) {
    for (const [k, v] of Object.entries(n.env)) {
      if (k && v !== undefined && v !== null) env[k] = String(v);
    }
  }
  const headers: Record<string, string> = {};
  if (n.headers) {
    for (const [k, v] of Object.entries(n.headers)) {
      if (k === 'oauth' || v === undefined || v === null) continue;
      headers[k] = String(v);
    }
  }
  return {
    type: n.type,
    url: n.url,
    command: n.command,
    args: n.args,
    env: Object.keys(env).length > 0 ? env : undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

function getDirectoryContents(dir: string): string[] {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir).map(f => {
      const full = join(dir, f);
      try { return f + (statSync(full).isDirectory() ? '/' : ''); } catch { return f; }
    });
  } catch { return []; }
}

function detectFromConfigs(): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  const seenPaths = new Set<string>();

  for (const ap of AGENT_PATHS) {
    if (seenPaths.has(ap.path)) continue;
    if (!existsSync(ap.path)) continue;
    seenPaths.add(ap.path);

    if (found.some(f => f.type === ap.type)) continue;

    const agent: DetectedAgent = {
      id: stableId(ap.name, ap.type, ap.dataPath || ap.path),
      name: ap.name,
      type: ap.type,
      configPath: ap.path,
      dataPath: ap.dataPath,
      iconPath: ap.icon,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      status: 'active',
      ...protectionInfoFor(ap.type),
    };

    agent.mcpServers = readMcpServers(ap.path, ap.type);
    agent.mcpCount = agent.mcpServers.length;

    found.push(agent);
  }

  return found;
}

export function detectFromPath(configPath: string): DetectedAgent | null {
  let resolved = configPath;
  if (resolved.startsWith('~/') || resolved === '~') {
    resolved = join(homedir(), resolved.slice(1));
  }
  if (!existsSync(resolved)) return null;

  for (const ap of AGENT_PATHS) {
    // Accept both the agent's config file AND its data directory, tolerant
    // of separator style, casing and trailing slashes (Windows users type
    // C:\…, C:/…, any case, and sometimes a trailing separator).
    if (pathsMatch(resolved, ap.path) || (ap.dataPath && pathsMatch(resolved, ap.dataPath))) {
      const agent: DetectedAgent = {
        id: stableId(ap.name, ap.type, ap.dataPath || ap.path),
        name: ap.name,
        type: ap.type,
        configPath: ap.path,
        dataPath: ap.dataPath,
        iconPath: ap.icon,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        status: 'active',
        ...protectionInfoFor(ap.type),
      };
      // Explicit user intent (manual add): hydrate full stats + data-dir
      // listing right away.
      hydrateAgentStats(agent, ap);

      return agent;
    }
  }

  return null;
}

/**
 * Windows-tolerant path comparison. win32.normalize converts / to \ and
 * strips trailing separators (except drive roots / UNC roots); NTFS is
 * case-insensitive so win mode also case-folds. On POSIX, plain normalize
 * is sufficient and comparison stays case-sensitive.
 */
export function pathsMatch(input: string, candidate: string, win: boolean = isWindows): boolean {
  // Trailing separators survive win32.normalize on non-root paths — strip
  // them so `C:\Users\…\.claude\` equals `C:\Users\…\.claude`.
  const norm = (p: string): string => (win ? win32.normalize(p) : normalize(p)).replace(/[\\/]+$/, '');
  return norm(input).toLowerCase() === norm(candidate).toLowerCase();
}

/**
 * Heavy per-agent stats hydration: data-dir parsing (history.jsonl,
 * projects/, opencode.db, codex state db, directory listing) is what makes
 * macOS Sequoia+ prompt "…would like to access data from other apps" — one
 * popup per scanned directory on every boot. Boot-time detection therefore
 * stays config-file-only; this hydrate step runs only when a single agent is
 * actually requested (detail page, manual add) — the directories that are
 * useful to the user right then, not every agent dir on the machine.
 */
function hydrateAgentStats(agent: DetectedAgent, ap: (typeof AGENT_PATHS)[number]): void {
  const parser = STATS_PARSERS[ap.type];
  if (parser) {
    agent.stats = parser({ path: ap.path, dataPath: ap.dataPath });
  }

  // dotEnvReads: audit rows + env vars declared in the agent's MCP config +
  // per-agent data-dir scans.
  let envCount = 0;
  try {
    const row = db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE params LIKE '%.env%' AND (agent LIKE ? OR agent LIKE ?)").get(`%${agent.name}%`, `%${agent.type}%`) as { n: number } | undefined;
    envCount += row?.n ?? 0;
  } catch { /* audit_log may not exist */ }

  if (agent.configPath) {
    try {
      const raw = readFileSync(agent.configPath, 'utf-8');
      const config = JSON.parse(raw) as McpConfig;
      const servers = config.mcpServers || config.mcp;
      if (servers) {
        for (const s of Object.values(servers)) {
          if (s.env) envCount += Object.keys(s.env).length;
        }
      }
    } catch {}
  }

  if (agent.dataPath) {
    if (agent.type === 'opencode') {
      try {
        const dbFile = join(agent.dataPath, 'opencode.db');
        const rows = queryDb(dbFile, "SELECT COUNT(*) FROM (SELECT id FROM session WHERE title LIKE '%.env%' UNION ALL SELECT id FROM message WHERE data LIKE '%.env%')");
        if (rows.length) envCount += (rows[0][0] as number);
      } catch {}
    } else if (agent.type === 'codex') {
      try {
        const codexPath = agent.dataPath || (agent.configPath ? dirname(agent.configPath) : '');
        const stateDb = join(codexPath, 'state_5.sqlite');
        const rows = queryDb(stateDb, "SELECT COUNT(*) FROM threads WHERE name LIKE '%.env%' OR summary LIKE '%.env%'");
        if (rows.length) envCount += (rows[0][0] as number);
      } catch {}
    } else if (agent.type === 'claude') {
      try {
        const history = readJsonl(join(agent.dataPath, 'history.jsonl'));
        envCount += history.filter(h => JSON.stringify(h).includes('.env')).length;
      } catch {}
      try {
        const projectsDir = join(agent.dataPath, 'projects');
        if (existsSync(projectsDir)) {
          const files = readdirSync(projectsDir).filter(f => f.endsWith('.jsonl'));
          for (const f of files) {
            const lines = readJsonl(join(projectsDir, f));
            envCount += lines.filter(l => JSON.stringify(l).includes('.env')).length;
          }
        }
      } catch {}
    }
  }

  if (!agent.stats) agent.stats = {};
  agent.stats.dotEnvReads = envCount;

  if (ap.dataPath) {
    agent.directoryContents = getDirectoryContents(ap.dataPath);
  }
}

export function detectAgents(): DetectedAgent[] {
  const found = detectFromConfigs();

  // Proxy traffic per detected agent: every proxied call is audited with the
  // client's declared identity (clientInfo.name, captured at the TCP/HTTP
  // ingress) — sum those rows into the agent's stats. Transport-tagged rows
  // (tcp:<addr>:<port>, api:<server>) carry neither the agent name nor type,
  // so they never leak into another agent's totals (no cross-attribution);
  // unhandshaken/unknown traffic is simply unclaimed, which is honest.
  const traffic = db.prepare(`
    SELECT COUNT(*) as total,
           COALESCE(SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END), 0) as allowed,
           COALESCE(SUM(CASE WHEN decision = 'deny'  THEN 1 ELSE 0 END), 0) as blocked,
           COALESCE(SUM(CASE WHEN decision = 'log'   THEN 1 ELSE 0 END), 0) as logged
    FROM audit_log
    WHERE (agent LIKE ? OR agent LIKE ?) AND method = 'tools/call'
  `);

  for (const agent of found) {
    const row = traffic.get(`%${agent.name}%`, `%${agent.type}%`) as
      { total: number; allowed: number; blocked: number; logged: number } | undefined;
    if (!agent.stats) agent.stats = {};
    // Always 0, never undefined — the UI can render a real "0 calls".
    agent.stats.proxyCalls = row?.total ?? 0;
    agent.stats.proxyAllowed = row?.allowed ?? 0;
    agent.stats.proxyBlocked = row?.blocked ?? 0;
    agent.stats.proxyLogged = row?.logged ?? 0;
  }

  const upsert = db.prepare(`
    INSERT INTO detected_agents (id, name, type, pid, command, config_path, first_seen, last_seen, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = excluded.last_seen,
      status = excluded.status
  `);

  db.prepare("UPDATE detected_agents SET status = 'inactive'").run();

  for (const agent of found) {
    upsert.run(
      agent.id, agent.name, agent.type,
      null, null, agent.configPath || null,
      agent.firstSeen, agent.lastSeen, agent.status,
    );
  }

  return found;
}

export function getDetectedAgents(): DetectedAgent[] {
  return db.prepare(`
    SELECT id, name, type, pid, command, config_path as configPath,
           first_seen as firstSeen, last_seen as lastSeen, status
    FROM detected_agents
    WHERE status = 'active'
    ORDER BY last_seen DESC
  `).all() as DetectedAgent[];
}

function findAllConfigPaths(): string[] {
  const paths: string[] = [];
  for (const ap of AGENT_PATHS) {
    if (existsSync(ap.path)) paths.push(ap.path);
  }
  return paths;
}

export function getAgentByType(type: string): DetectedAgent | null {
  const agents = detectAgents();
  const agent = agents.find(a => a.type === type) || null;
  if (agent) {
    // Detail-page request = explicit user intent: hydrate the heavy
    // data-dir stats now (boot scan stays light).
    const ap = AGENT_PATHS.find((a) => a.type === type);
    if (ap) hydrateAgentStats(agent, ap);
  }
  return agent;
}

/**
 * Hydrate session/message/token stats for every detected agent in place.
 * detectAgents() deliberately stays config-file-only (light) so boot scans
 * don't walk every agent's data dir; dashboards (Most Active Agent) and the
 * Agents list need the real stat values, so call this on the detection result
 * when the full picture is required. Uses the canonical AGENT_PATHS entry for
 * each type (works the same as getAgentByType's detail hydration).
 */
export function hydrateAllAgentStats(agents: DetectedAgent[]): DetectedAgent[] {
  for (const agent of agents) {
    const ap = AGENT_PATHS.find((a) => a.type === agent.type);
    if (ap) hydrateAgentStats(agent, ap);
  }
  return agents;
}

export function getMcpServersFromConfigs(): { name: string; type: string; url?: string; command?: string }[] {
  const servers: { name: string; type: string; url?: string; command?: string }[] = [];
  // A project-level .mcp.json takes precedence over user-level agent configs
  // (its names win via the `seen` set below) — but it must not REPLACE the
  // scan. A project config alone would shadow every agent-declared server,
  // so newly added agent MCPs would never be detected (the backend's own
  // cwd ships a .mcp.json in dev and in the packaged app). Scan both.
  const projectConfig = join(process.cwd(), '.mcp.json');
  const configPaths = [
    ...(existsSync(projectConfig) ? [projectConfig] : []),
    ...findAllConfigPaths(),
  ];

  // Bindings: which agent type owns each scanned config path (project-level
  // .mcp.json has no AGENT_PATHS entry → no owner, so it contributes servers
  // but never bindings).
  const agentTypeByPath = new Map(AGENT_PATHS.map((ap) => [ap.path, ap.type]));
  // server name -> every agent type whose config declares it. A server can be
  // declared by multiple agents at once; each declaration is a real binding,
  // even though only the FIRST declaring config wins the mcp_servers row.
  const declarers = new Map<string, Set<string>>();
  const recordDeclarer = (name: string, agentType: string | undefined) => {
    if (!agentType) return;
    if (!declarers.has(name)) declarers.set(name, new Set());
    declarers.get(name)!.add(agentType);
  };

  const seen = new Set<string>();
  for (const configPath of configPaths) {
    const config = readAgentConfig(configPath);
    if (!config) {
      // findAllConfigPaths()/existsSync above guarantee the file exists, so a
      // null here means the file failed to parse — surface it instead of
      // silently dropping every server that config declared.
      console.warn(`[detector] Skipping unreadable/malformed config: ${configPath}`);
      continue;
    }
    const container = serverContainer(config);

    // Cline CLI: its MCP connectors live in ~/.cline/data/db/connectors.db
    // (readAgentConfig returns {} for the `data` directory, so the normal
    // container path above would see nothing). Register each enabled connector
    // so it shows up in TestMCP and can be spawned/managed by the firewall —
    // no per-MCP manual config needed, just install (npx etc.) and the scan
    // picks it up automatically.
    if (isClineDataDir(configPath)) {
      for (const srv of readClineCliServers(configPath)) {
        if (seen.has(srv.name)) continue;
        const tomb = db.prepare('SELECT removed FROM mcp_servers WHERE name = ?').get(srv.name) as { removed?: number } | undefined;
        if (tomb?.removed === 1) { seen.add(srv.name); continue; }
        const cmd = srv.command ? srv.command.split(' ') : [];
        db.prepare(`
          INSERT INTO mcp_servers (name, type, url, command, args, env, connected, last_check, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, 1, datetime('now'), datetime('now'))
          ON CONFLICT(name) DO UPDATE SET
            type = excluded.type, url = excluded.url,
            command = excluded.command, args = excluded.args,
            connected = 1, last_check = datetime('now')
        `).run(srv.name, srv.type, srv.url ?? null, cmd[0] || null, cmd.length > 1 ? JSON.stringify(cmd.slice(1)) : null);
        db.prepare(`
          INSERT INTO agent_connectors (agent_type, server_name, enabled, bound_at, origin)
          VALUES ('cline', ?, 1, datetime('now'), 'discovered')
          ON CONFLICT(agent_type, server_name) DO UPDATE SET enabled = 1, bound_at = datetime('now')
        `).run(srv.name);
        seen.add(srv.name);
        servers.push({ name: srv.name, type: srv.type, url: srv.url, command: srv.command });
      }
      continue;
    }

    for (const [name, rawEntry] of Object.entries(container)) {
      const entry = normalizeServerEntry(rawEntry);
      if (!entry) continue;
      const agentType = agentTypeByPath.get(configPath);

      // Respect the user's removal: a tombstoned (removed=1) row is skipped
      // here so the 30s scan never re-INSERTs a connector the user deleted.
      // This is what keeps TestMCP deletions permanent for disk-declared MCPs.
      const tomb = db.prepare('SELECT removed FROM mcp_servers WHERE name = ?').get(name) as { removed?: number } | undefined;
      if (tomb?.removed === 1) {
        seen.add(name);
        continue;
      }

      // Every agent whose config declares this server gets a binding row —
      // even when another config already won the mcp_servers registration
      // (first-declared name wins there, but bindings are per (agent, server)).
      recordDeclarer(name, agentType);

      // First agent to declare a name wins the server registration.
      if (seen.has(name)) continue;

      // Already flowing through the HTTP ingress (rewriter converted it):
      // keep the existing DB row untouched — likely a stdio config the proxy
      // is already driving.
      if (entry.url && isProxyIngressUrl(entry.url)) {
        seen.add(name);
        servers.push({ name, type: 'http', url: entry.url });
        continue;
      }

      db.prepare(`
        INSERT INTO mcp_servers (name, type, url, command, args, env, connected, last_check, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
        ON CONFLICT(name) DO UPDATE SET
          type = excluded.type, url = excluded.url,
          command = excluded.command, args = excluded.args, env = excluded.env,
          connected = 1,
          last_check = datetime('now')
          -- headers / auth_type / created_at intentionally untouched: the
          -- agent config has no credentials, overwriting them on every
          -- scan would wipe a user's saved auth.
      `).run(
        name,
        entry.type,
        entry.url || null,
        entry.command || null,
        entry.args && entry.args.length > 0 ? JSON.stringify(entry.args) : null,
        entry.env ? JSON.stringify(entry.env) : null,
      );

      seen.add(name);
      servers.push({ name, type: entry.type, url: entry.url, command: entry.command });
    }
  }

  // Persist bindings discovered during the scan. Only rows this scanner owns
  // ('discovered') are created — manual binds/unbinds from the UI carry
  // origin='manual' and are never touched here, so an explicit unbind isn't
  // resurrected by the next 30s scan even though the config still declares
  // the server.
  const bind = db.prepare(`
    INSERT INTO agent_connectors (agent_type, server_name, enabled, bound_at, origin)
    VALUES (?, ?, 1, datetime('now'), 'discovered')
    ON CONFLICT(agent_type, server_name) DO NOTHING
  `);
  for (const [name, types] of declarers) {
    for (const t of types) bind.run(t, name);
  }

  return servers;
}

/**
 * Auto-registration scan used by the backend boot + interval job: register
 * every connector declared in any detected agent config into mcp_servers, and
 * report which names were CREATED by this pass (so the caller can spawn stdio
 * children and broadcast connector.status for a live-refreshing TestMCP page).
 */
export function autoDiscoverConnectors(): { servers: { name: string; type: string; url?: string; command?: string }[]; created: string[] } {
  const before = new Set(
    (db.prepare('SELECT name FROM mcp_servers').all() as { name: string }[]).map((r) => r.name),
  );
  const servers = getMcpServersFromConfigs();
  const after = new Set(
    (db.prepare('SELECT name FROM mcp_servers').all() as { name: string }[]).map((r) => r.name),
  );
  return { servers, created: [...after].filter((n) => !before.has(n)) };
}
