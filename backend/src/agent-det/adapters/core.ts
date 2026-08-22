import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { parse as parseJsonc, parseTree, findNodeAtLocation, modify, applyEdits, type ParseError } from 'jsonc-parser';
import type { McpEntry } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Adapter core — the shared primitives every adapter is built from.
//
// Extracted verbatim from config-fetch.ts during the adapter-registry
// refactor (v1.1.9-c): the injectable fs slot, the JSONC-safe reader, the MCP
// entry extractor and the byte-preserving injection engine all live here so
// adapters and the legacy config-fetch facade share ONE implementation.
// config-fetch.ts re-exports these, so existing import sites (and the
// node:test virtual-fs suite) are unchanged.
//
// PURE module: no db, no proxy, no electron — only fs + jsonc-parser.
// ─────────────────────────────────────────────────────────────────────────────

/** Injectable fs so unit tests run against a virtual filesystem. The app
 *  always uses the real node:fs; only node:test swaps the implementation. */
export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf-8'): string;
  statSync(p: string): { mtimeMs: number };
  writeFileSync(p: string, data: string): void;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
}
let fsImpl: FsLike = { existsSync, readFileSync, statSync, writeFileSync, mkdirSync };

export function getFs(): FsLike {
  return fsImpl;
}

export function setFsForTests(f: FsLike | null): void {
  fsImpl = f ?? { existsSync, readFileSync, statSync, writeFileSync, mkdirSync };
}

// [CF] trace logging (D3): every step of the fetch pipeline logs its
// progress behind the dev flag. Production stays quiet.
export const cfTrace = process.env.CF_DEV === '1' || process.env.NODE_ENV !== 'production';
export function trace(...args: unknown[]): void {
  if (cfTrace) console.log('[CF]', ...args);
}

export const h = homedir();
export const isWindows = process.platform === 'win32';

/** OS-specific app config dir: %APPDATA% on Windows, ~/Library/Application
 *  Support on macOS, ~/.config on Linux. */
export function osConfigDir(...parts: string[]): string {
  const root = isWindows
    ? join(h, 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? join(h, 'Library', 'Application Support')
      : join(h, '.config');
  return join(root, ...parts);
}

// ── Master path specs ────────────────────────────────────────────────────────
// Single ordered source of truth for EVERY scanned agent config path. Each
// spec names the adapter that owns it (`owner`), plus the display metadata
// detector.ts needs (name/type/icon/dataPath). Order is load-bearing:
//   - fetchAllMcps merges entries by name, first path wins
//   - findConfigPath-style consumers take the first EXISTING path per type
//   - the Cline settings file must precede the ~/.cline/data directory entry
// Legacy agents without a dedicated adapter (Codex, GitHub Copilot, Continue,
// Aider) keep their entries with owner 'legacy' — detection and stats parsing
// for them are unchanged.
export interface PathSpec {
  path: string;
  owner:
    | 'opencode'
    | 'claude-desktop'
    | 'claude-code'
    | 'cline'
    | 'cursor'
    | 'windsurf'
    | 'antigravity'
    | 'project-local'
    | 'legacy';
  name: string;
  type: string;
  icon?: string;
  dataPath?: string;
  /** False for paths that must NOT become chokidar watch targets. */
  watch?: false;
}

const OPENCODE_ICON = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/opencode.png';
const CLAUDE_ICON = 'https://uxwing.com/wp-content/themes/uxwing/download/brands-and-social-media/claude-ai-icon.png';
const CLINE_ICON = 'https://cline.bot/assets/branding/favicons/favicon-256x256.png';

export const MASTER_PATH_SPECS: PathSpec[] = [
  // ── Cursor (fallback file first — historical scan order preserved) ────────
  { path: join(h, '.cursor', 'mcp.json'), owner: 'cursor', name: 'Cursor', type: 'cursor', icon: 'https://www.gartner.com/pi/vendorimages/anysphere_cursor_1771021658737.png' },
  // ── Claude Desktop ────────────────────────────────────────────────────────
  { path: osConfigDir('Claude', 'claude_desktop_config.json'), owner: 'claude-desktop', name: 'Claude Desktop', type: 'claude', dataPath: join(h, '.claude'), icon: CLAUDE_ICON },
  { path: join(h, '.config', 'claude', 'claude_desktop_config.json'), owner: 'claude-desktop', name: 'Claude Desktop', type: 'claude', dataPath: join(h, '.claude'), icon: CLAUDE_ICON },
  // ── OpenCode (order matters: jsonc before json at each location — A4) ─────
  { path: join(h, '.config', 'opencode', 'opencode.jsonc'), owner: 'opencode', name: 'OpenCode', type: 'opencode', dataPath: join(h, '.local', 'share', 'opencode'), icon: OPENCODE_ICON },
  { path: join(h, '.config', 'opencode', 'opencode.json'), owner: 'opencode', name: 'OpenCode', type: 'opencode', dataPath: join(h, '.local', 'share', 'opencode'), icon: OPENCODE_ICON },
  { path: join(h, '.opencode', 'opencode.jsonc'), owner: 'opencode', name: 'OpenCode', type: 'opencode', dataPath: join(h, '.local', 'share', 'opencode'), icon: OPENCODE_ICON },
  { path: join(h, '.opencode', 'opencode.json'), owner: 'opencode', name: 'OpenCode', type: 'opencode', dataPath: join(h, '.local', 'share', 'opencode'), icon: OPENCODE_ICON },
  { path: join(h, 'opencode.jsonc'), owner: 'opencode', name: 'OpenCode', type: 'opencode', dataPath: join(h, '.local', 'share', 'opencode'), icon: OPENCODE_ICON },
  { path: join(h, 'opencode.json'), owner: 'opencode', name: 'OpenCode', type: 'opencode', dataPath: join(h, '.local', 'share', 'opencode'), icon: OPENCODE_ICON },
  // cwd-relative variants (new in v1.1.9-c): opencode also reads project-local
  // configs, and `npx shadcn mcp init` has been observed writing them.
  { path: join(process.cwd(), 'opencode.jsonc'), owner: 'opencode', name: 'OpenCode', type: 'opencode', dataPath: join(h, '.local', 'share', 'opencode'), icon: OPENCODE_ICON },
  { path: join(process.cwd(), 'opencode.json'), owner: 'opencode', name: 'OpenCode', type: 'opencode', dataPath: join(h, '.local', 'share', 'opencode'), icon: OPENCODE_ICON },
  // ── Claude Code ───────────────────────────────────────────────────────────
  { path: join(h, '.claude', 'settings.json'), owner: 'claude-code', name: 'Claude Code', type: 'claude', dataPath: join(h, '.claude'), icon: CLAUDE_ICON },
  // New in v1.1.9-c: additional Claude Code config locations.
  { path: join(h, '.claude', 'claude_code_config.json'), owner: 'claude-code', name: 'Claude Code', type: 'claude', dataPath: join(h, '.claude'), icon: CLAUDE_ICON },
  { path: join(h, '.claude.json'), owner: 'claude-code', name: 'Claude Code', type: 'claude', dataPath: join(h, '.claude'), icon: CLAUDE_ICON },
  { path: join(process.cwd(), '.claude', 'settings.json'), owner: 'claude-code', name: 'Claude Code', type: 'claude', dataPath: join(h, '.claude'), icon: CLAUDE_ICON },
  // ── Legacy agents (no dedicated adapter — detection/stats unchanged) ──────
  { path: join(h, '.codex', 'config.toml'), owner: 'legacy', name: 'Codex', type: 'codex' },
  { path: join(h, '.config', 'github-copilot', 'config.json'), owner: 'legacy', name: 'GitHub Copilot', type: 'copilot', dataPath: join(h, '.config', 'github-copilot'), icon: 'https://img.icons8.com/3d-fluency/1200/github-copilot.jpg' },
  // ── Cline ─────────────────────────────────────────────────────────────────
  // PRIMARY (audit finding, this machine): the Cline CLI's LIVE MCP config —
  // the CLI reads this exact file at startup (same `mcpServers` shape as the
  // extension's cline_mcp_settings.json). It MUST precede the ~/.cline/data
  // directory entry below: "first existing path wins" logic hands this JSON
  // to protectAgent, which is the only rewritable surface — the data dir
  // itself is a SQLite store that must never be edited in place.
  { path: join(h, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  // VSCode extension globalStorage (GUI install).
  { path: osConfigDir('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  // VSCode Insiders variant.
  { path: osConfigDir('Code - Insiders', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  // Cursor-editor globalStorage variant (Cline installed inside Cursor).
  { path: osConfigDir('Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  // Cline CLI candidates (new-in-spec mcp_settings.json locations…)
  { path: join(h, '.cline', 'mcp_settings.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  { path: join(h, '.config', 'cline', 'mcp_settings.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  { path: join(process.cwd(), '.cline', 'mcp_settings.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  // …and the pre-existing CLI/global paths kept for continuity (A1 pins
  // ~/.cline/config.json in the required-path-list test).
  { path: join(h, '.cline', 'mcp.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  { path: join(h, '.cline', 'config.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  { path: join(h, '.config', 'cline', 'mcp.json'), owner: 'cline', name: 'Cline', type: 'cline', icon: CLINE_ICON },
  // Fallback for older CLI builds without a settings file: the data DIRECTORY
  // (~/.cline/data). Existence is the detection signal; readers return an
  // empty-but-valid result for a directory instead of failing. Must stay
  // LAST among cline paths (test-pinned ordering).
  { path: join(h, '.cline', 'data'), owner: 'cline', name: 'Cline', type: 'cline', dataPath: join(h, '.cline'), icon: CLINE_ICON },
  // ── Legacy agents (continued) ─────────────────────────────────────────────
  { path: join(h, '.continue', 'config.json'), owner: 'legacy', name: 'Continue', type: 'continue', icon: 'https://avatars.githubusercontent.com/u/127876214?v=4' },
  { path: join(h, '.continue', 'config.yaml'), owner: 'legacy', name: 'Continue', type: 'continue', icon: 'https://avatars.githubusercontent.com/u/127876214?v=4' },
  // ── Windsurf ──────────────────────────────────────────────────────────────────────
  { path: join(h, '.codeium', 'windsurf', 'mcp_config.json'), owner: 'windsurf', name: 'Windsurf', type: 'windsurf', icon: 'https://windsurf.com/favicon_270.png' },
  { path: join(h, '.windsurf', 'mcp.json'), owner: 'windsurf', name: 'Windsurf', type: 'windsurf', icon: 'https://windsurf.com/favicon_270.png' },
  // ── Gemini CLI / Antigravity ──────────────────────────────────────────────
  // PRIMARY (audit finding, this machine): the agy CLI stores MCP servers in
  // ~/.gemini/config/mcp_config.json (`mcpServers` block, MCP-spec entries).
  { path: join(h, '.gemini', 'config', 'mcp_config.json'), owner: 'antigravity', name: 'Gemini CLI (Antigravity)', type: 'gemini', dataPath: join(h, '.gemini'), icon: 'https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png' },
  // Older/alternate Gemini CLI locations (settings.json `mcpServers` block).
  { path: join(h, '.gemini', 'settings.json'), owner: 'antigravity', name: 'Gemini CLI (Antigravity)', type: 'gemini', icon: 'https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png' },
  { path: join(h, '.config', 'gemini', 'settings.json'), owner: 'antigravity', name: 'Gemini CLI (Antigravity)', type: 'gemini', icon: 'https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png' },
  { path: join(h, '.antigravity', 'mcp_settings.json'), owner: 'antigravity', name: 'Gemini CLI (Antigravity)', type: 'gemini', icon: 'https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png' },
  { path: join(h, '.config', 'antigravity', 'mcp_settings.json'), owner: 'antigravity', name: 'Gemini CLI (Antigravity)', type: 'gemini', icon: 'https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png' },
  { path: join(process.cwd(), '.gemini', 'settings.json'), owner: 'antigravity', name: 'Gemini CLI (Antigravity)', type: 'gemini', icon: 'https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png' },
  // ── Legacy agents (continued) ─────────────────────────────────────────────
  { path: join(h, '.aider.conf.yml'), owner: 'legacy', name: 'Aider', type: 'aider', icon: 'https://aider.chat/assets/aider-square.jpg' },
  // ── Project-local .mcp.json (scanned last; project names still win via the
  //    explicit priority block in detector.getMcpServersFromConfigs) ─────────
  { path: join(process.cwd(), '.mcp.json'), owner: 'project-local', name: 'Project MCP', type: 'project' },
];

export function specsForOwner(owner: PathSpec['owner']): PathSpec[] {
  return [...MASTER_PATH_SPECS, ...EXTRA_PATH_SPECS].filter((s) => s.owner === owner);
}

/** Glob-discovered paths registered once at startup (Cline extension
 *  fallback, Cursor globalStorage expansion). Appended AFTER the static
 *  master list — static candidates always take priority. */
export const EXTRA_PATH_SPECS: PathSpec[] = [];

export function registerExtraSpecs(specs: PathSpec[]): void {
  EXTRA_PATH_SPECS.push(...specs);
}

/** Every scanned path in priority order (master list, then glob hits). */
export function allPathSpecs(): PathSpec[] {
  return [...MASTER_PATH_SPECS, ...EXTRA_PATH_SPECS];
}

/** First EXISTING candidate path for an owner; `fallback` when none exists. */
export function pickOwnerConfigPath(owner: PathSpec['owner'], fallback: string): string {
  for (const s of specsForOwner(owner)) {
    try {
      if (getFs().existsSync(s.path)) return s.path;
    } catch { /* treat as missing */ }
  }
  return fallback;
}

export function detectFormat(path: string): 'json' | 'jsonc' | 'yaml' | 'toml' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.jsonc')) return 'jsonc';
  return 'json';
}

// ── JSONC parsing (A2) ───────────────────────────────────────────────────────
// Every failure mode is caught and reported, never thrown:
//   - comments + trailing commas → handled by jsonc-parser (real tokenizer,
//     so "http://" inside a string value is never mistaken for a comment)
//   - malformed JSON → parse errors collected, file reported + skipped
//   - empty / whitespace-only / comment-only file → null (caller → [])
//   - BOM → stripped before parsing
//   - parsed value is not a plain object → null
export function parseJsoncConfig(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/^\uFEFF/, '');
  const errors: ParseError[] = [];
  const doc = parseJsonc(cleaned, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) return null;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc as Record<string, unknown>;
  return null;
}

// ── MCP extraction (A3) ──────────────────────────────────────────────────────
// opencode uses "mcp", every other agent uses "mcpServers" — accept both.
// Each entry is normalized to { name, type, command[], enabled, source };
// entries with neither a command nor a url are unusable and dropped.
//
// The MCP spec uses command (string) + args (array); many clients also accept
// command as an array. Cline uses command:string + args:array + "disabled"
// (inverted boolean). Both styles are merged here so the command array always
// reflects the full invocation regardless of which keys the config author used.
export function parseMcpEntries(source: string, text: string): { entries: McpEntry[]; parseError?: string } {
  const parsed = parseJsoncConfig(text);
  if (parsed === null) {
    return { entries: [], parseError: 'Malformed JSON/JSONC — skipping file' };
  }
  const mcpMap = (parsed.mcp ?? parsed.mcpServers) as Record<string, unknown> | undefined;
  if (!mcpMap || typeof mcpMap !== 'object' || Array.isArray(mcpMap)) return { entries: [] };

  const entries: McpEntry[] = [];
  for (const [name, cfgRaw] of Object.entries(mcpMap)) {
    if (!cfgRaw || typeof cfgRaw !== 'object' || Array.isArray(cfgRaw)) continue;
    const cfg = cfgRaw as { type?: unknown; command?: unknown; args?: unknown; url?: unknown; enabled?: unknown; disabled?: unknown; env?: unknown };
    const url = typeof cfg.url === 'string' && cfg.url.trim() ? cfg.url.trim() : undefined;
    // Merge command + args. Cline writes command as a string with separate args;
    // other clients may use command as an array. Combine both into one list.
    const args = Array.isArray(cfg.args)
      ? cfg.args.map((a) => String(a)).filter((a) => a.trim() !== '')
      : [];
    const commandBase = Array.isArray(cfg.command)
      ? cfg.command.map((c) => String(c)).filter((c) => c.trim() !== '')
      : typeof cfg.command === 'string' && cfg.command.trim()
        ? [cfg.command.trim()]
        : [];
    const command = [...commandBase, ...args];
    if (!url && command.length === 0) continue;
    // Cline uses "disabled" (inverted); fall back to "enabled" for other clients.
    const enabled = cfg.disabled !== undefined
      ? !Boolean(cfg.disabled)
      : cfg.enabled === undefined
        ? true
        : Boolean(cfg.enabled);
    const env = cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)
      ? Object.fromEntries(
          Object.entries(cfg.env as Record<string, unknown>)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined;
    entries.push({
      name,
      // Legacy parity: agent configs may carry arbitrary transport labels
      // ("sse", "ws", …) — pass them through untouched rather than collapsing
      // to the documented union.
      type: (typeof cfg.type === 'string' ? cfg.type : url ? 'http' : 'local') as McpEntry['type'],
      command,
      enabled,
      source,
      ...(url ? { url } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  return { entries };
}

// Legacy entry shape (the one config-fetch.ts has always exported). Adapters
// work in the richer core shape and convert at the boundary.
export interface LegacyMcpEntry {
  name: string;
  type: string;
  command: string[];
  enabled: boolean;
  source: string;
  url?: string;
}

export function toLegacyEntry(e: McpEntry): LegacyMcpEntry {
  return {
    name: e.name,
    type: e.type,
    command: e.command ?? [],
    enabled: e.enabled ?? true,
    source: e.source,
    ...(e.url ? { url: e.url } : {}),
  };
}

// ── Per-path read pipeline (ported verbatim from config-fetch.ts) ────────────
// Read ONE config file through the fetch pipeline. Never throws: missing
// files, unreadable files and non-JSON formats (yaml/toml — handled by the
// YAML-based discovery path, not this pipeline) come back as empty results
// with an explanatory flag.
export interface PathReadResult {
  exists: boolean;
  mtimeMs?: number;
  parseError?: string;
  entries: McpEntry[];
  raw?: string;
}

export function readConfigPath(path: string, opts?: { includeRaw?: boolean }): PathReadResult {
  const fs = getFs();
  const base: PathReadResult = { exists: false, entries: [] };
  try {
    if (!fs.existsSync(path)) return base;
    const stat = fs.statSync(path);
    base.exists = true;
    base.mtimeMs = stat.mtimeMs;
    // Some agent "configs" are DIRECTORIES, not flat files (e.g. Cline CLI's
    // ~/.cline/data). Existence is the detection signal, but there is no JSON
    // to read — return an empty (no-error) result instead of surfacing an
    // "Unreadable" parse error in every pipeline that lists config paths.
    if ((stat as { isDirectory?: () => boolean }).isDirectory?.()) {
      return base;
    }
    const format = detectFormat(path);
    if (format === 'yaml' || format === 'toml') {
      // Parsed by the agent-discovery path (js-yaml / TOML), not here.
      base.parseError = 'non-JSON format — parsed by the YAML discovery path, skipped by the JSON fetch pipeline';
      return base;
    }
    const raw = fs.readFileSync(path, 'utf-8');
    if (opts?.includeRaw) base.raw = raw;
    const { entries, parseError } = parseMcpEntries(path, raw);
    base.entries = entries;
    if (parseError) base.parseError = parseError;
    return base;
  } catch (err) {
    base.parseError = `Unreadable: ${err instanceof Error ? err.message : String(err)}`;
    return base;
  }
}

// ── Byte-preserving entry injection (C1) ─────────────────────────────────────
// Text-level splice using jsonc-parser node offsets: comments, whitespace and
// unrelated content in the target file are preserved byte-for-byte. Only the
// new entry (and the comma it needs) is added.
//
// When `clineFormat` is set the entry is serialized in the MCP-spec style that
// Cline expects: `command` as a string (first element only) + `args` as an
// array (the rest). The `name` field is omitted from the value because Cline
// uses the object key as the server name, and a `mcpServers` key is created
// (instead of `mcp`) when no container exists yet.
export interface InjectableEntry {
  name: string;
  type?: string;
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** When true, writes command (string) + args (array) for Cline compatibility. */
  clineFormat?: boolean;
  /** When set (clineFormat only), stored as Cline's `disabled` boolean. */
  disabled?: boolean;
  enabled?: boolean;
}

export function injectMcpEntryAt(
  path: string,
  entry: InjectableEntry,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const isOpencode = /opencode/i.test(path);
    const isCline = entry.clineFormat || /cline/i.test(path);

    if (!getFs().existsSync(path)) {
      getFs().mkdirSync(dirname(path), { recursive: true });
      const serverKey = isOpencode ? 'mcp' : 'mcpServers';
      getFs().writeFileSync(path, `{\n  "${serverKey}": {}\n}\n`);
    }
    const text = getFs().readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (!root || root.type !== 'object') {
      return { ok: false, error: 'Config is not a JSON object — refusing to rewrite it' };
    }

    const hasMcpKey = !!findNodeAtLocation(root, ['mcp']);
    const serverContainerKey = (isOpencode || hasMcpKey) ? 'mcp' : 'mcpServers';

    let valueObj: Record<string, unknown>;
    if (serverContainerKey === 'mcp') {
      if (entry.url) {
        valueObj = {
          type: 'remote',
          enabled: entry.enabled !== false,
          url: entry.url,
        };
      } else {
        const cmd = entry.command ?? [];
        const envObj = entry.env && Object.keys(entry.env).length > 0 ? entry.env : undefined;
        valueObj = {
          type: 'local',
          enabled: entry.enabled !== false,
          command: cmd,
          ...(envObj ? { environment: envObj } : {}),
        };
      }
    } else if (isCline) {
      if (entry.url) {
        valueObj = {
          url: entry.url,
          disabled: entry.disabled ?? false,
        };
      } else {
        const cmdList = entry.command ?? [];
        const cmdStr = cmdList[0] ?? '';
        const argsArr = cmdList.slice(1);
        const envObj = entry.env && Object.keys(entry.env).length > 0 ? entry.env : undefined;
        valueObj = {
          command: cmdStr,
          args: argsArr,
          ...(envObj ? { env: envObj } : {}),
          disabled: entry.disabled ?? false,
        };
      }
    } else {
      if (entry.url) {
        valueObj = { url: entry.url };
      } else {
        const cmdList = entry.command ?? [];
        const cmdStr = cmdList[0] ?? '';
        const argsArr = cmdList.slice(1);
        const envObj = entry.env && Object.keys(entry.env).length > 0 ? entry.env : undefined;
        valueObj = {
          command: cmdStr,
          args: argsArr,
          ...(envObj ? { env: envObj } : {}),
        };
      }
    }

    const formattingOptions = {
      insertSpaces: true,
      tabSize: 2,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
    };

    const edits = modify(text, [serverContainerKey, entry.name], valueObj, { formattingOptions });
    const next = applyEdits(text, edits);
    getFs().writeFileSync(path, next);
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
