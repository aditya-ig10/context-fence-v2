// ─────────────────────────────────────────────────────────────────────────────
// Config fetch pipeline — the canonical list of MCP config files Context
// Fence scans, and the JSONC-safe reader used by every surface that asks
// "what MCPs are declared on disk?" (auto-discovery, the refresh button, the
// install-gap check, the dev debug panel, sequential-thinking detection).
//
// Since v1.1.9-c this module is a FACADE over the agent-det adapters: the
// scan list derives from the adapter registry (single source of truth shared
// with detector.ts AGENT_PATHS and the index.ts chokidar watcher), per-path
// reads route through the owning adapter, and the parsing/injection engines
// live in adapters/core.ts. Every export below keeps its pre-refactor shape —
// zero call sites broke, and the node:test virtual-fs suite runs unchanged.
//
// PURE module: no db, no proxy, no electron — only fs + jsonc-parser. Unit
// tests inject a virtual filesystem via __setFsForTests (node:test).
// ─────────────────────────────────────────────────────────────────────────────

import { join } from 'path';
import {
  cfTrace,
  trace,
  detectFormat,
  parseJsoncConfig,
  parseMcpEntries as parseMcpEntriesCore,
  readConfigPath,
  toLegacyEntry,
  setFsForTests,
  getFs,
  injectMcpEntryAt,
  pickOwnerConfigPath,
  osConfigDir,
  h,
} from './adapters/core.js';
import type { FsLike } from './adapters/core.js';
import { adapterForPath, getAgentPathDescriptors } from './adapters/registry.js';
import { BaseAgentAdapter } from './adapters/base.js';

export { cfTrace, trace, parseJsoncConfig };

// ── Legacy shapes (unchanged since v1.1.8) ───────────────────────────────────

export interface McpEntry {
  name: string;
  type: string;
  command: string[];
  enabled: boolean;
  source: string;
  url?: string;
}

export interface ConfigPath {
  path: string;
  name: string;
  type: string;
}

export type ConfigFormat = 'json' | 'jsonc' | 'yaml' | 'toml' | null;

export interface ConfigReadResult {
  path: string;
  name: string;
  type: string;
  exists: boolean;
  format: ConfigFormat;
  mtimeMs?: number;
  parseError?: string;
  entries: McpEntry[];
  raw?: string;
}

// Canonical scan list (A1), now DERIVED from the adapter registry. Order
// matters exactly as before: for agent types with several config files, the
// FIRST existing one wins as the agent's primary config; the fetch pipeline
// merges entries across all of them by name (first wins). The no-`c`
// opencode.json variants are scanned too (A4): `npx shadcn@latest mcp init
// --client opencode` has been observed writing to opencode.json instead of
// opencode.jsonc, silently dropping the entry from the UI.
export const CONFIG_PATHS: ConfigPath[] = getAgentPathDescriptors().map((d) => ({
  path: d.path,
  name: d.name,
  type: d.type,
}));

// Injectable fs so unit tests run against a virtual filesystem. The app
// always uses the real node:fs; only node:test swaps the implementation.
// Delegates to the shared slot in adapters/core.ts so every adapter obeys the
// same swap.
export function __setFsForTests(f: FsLike | null): void {
  setFsForTests(f);
}

/**
 * Extract MCP entries from raw config text (re-export of the shared engine —
 * see adapters/core.ts parseMcpEntries for the JSONC/comment/BOM contract).
 */
export function parseMcpEntries(source: string, text: string): { entries: McpEntry[]; parseError?: string } {
  const res = parseMcpEntriesCore(source, text);
  return {
    entries: res.entries.map(toLegacyEntry),
    ...(res.parseError ? { parseError: res.parseError } : {}),
  };
}

// Read ONE config file through the fetch pipeline. Never throws: missing
// files, unreadable files and non-JSON formats (yaml/toml — handled by the
// YAML-based discovery path, not this pipeline) come back as empty results
// with an explanatory flag.
//
// Routing: the path's owning ADAPTER performs the read (so adapter-specific
// behavior applies as the registry grows); paths without an owner (legacy
// agents: Codex/Copilot/Continue/Aider) fall through to the same shared
// pipeline the adapters use. Results are converted back to the legacy
// ConfigReadResult shape — name/type/format come from the caller's ConfigPath,
// exactly as before the refactor.
export function fetchMcpsFromConfig(cfg: ConfigPath, opts?: { includeRaw?: boolean }): ConfigReadResult {
  const base: ConfigReadResult = {
    path: cfg.path,
    name: cfg.name,
    type: cfg.type,
    exists: false,
    format: detectFormat(cfg.path),
    entries: [],
  };
  try {
    // includeRaw bypasses adapter routing: the shared pipeline keeps the raw
    // text; adapter reads don't surface it.
    const adapter = opts?.includeRaw ? null : adapterForPath(cfg.path);
    let read: ReturnType<typeof readConfigPath>;
    if (adapter instanceof BaseAgentAdapter) {
      const r = adapter.readPath(cfg.path);
      read = { exists: r.exists, ...(r.mtimeMs !== undefined ? { mtimeMs: r.mtimeMs } : {}), ...(r.parseError ? { parseError: r.parseError } : {}), entries: r.entries };
    } else {
      read = readConfigPath(cfg.path, opts);
    }
    base.exists = read.exists;
    if (read.mtimeMs !== undefined) base.mtimeMs = read.mtimeMs;
    if (read.parseError) base.parseError = read.parseError;
    base.entries = read.entries.map(toLegacyEntry);
    return base;
  } catch (err) {
    base.parseError = `Unreadable: ${err instanceof Error ? err.message : String(err)}`;
    return base;
  }
}

// Full pipeline (the "fetch" every refresh button must trigger): read every
// known config, merge entries, deduplicate by name (first file wins — same
// rule as the DB-backed discovery), report per-file results. The scan list
// comes straight from the adapter registry (master specs + startup glob hits).
export function fetchAllMcps(): { entries: McpEntry[]; results: ConfigReadResult[]; durationMs: number } {
  const t0 = Date.now();
  trace(`Scanning ${CONFIG_PATHS.length} config paths…`);
  const results: ConfigReadResult[] = [];
  const seen = new Set<string>();
  const entries: McpEntry[] = [];
  for (const cfg of CONFIG_PATHS) {
    const res = fetchMcpsFromConfig(cfg);
    results.push(res);
    if (res.entries.length > 0) trace(`Parsed ${res.entries.length} MCPs from ${cfg.name} (${cfg.path})`);
    for (const e of res.entries) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      entries.push(e);
    }
  }
  const durationMs = Date.now() - t0;
  trace(`Total MCPs: ${entries.length}`, `Refresh complete in ${durationMs}ms`);
  return { entries, results, durationMs };
}

// ── Entry injection (C1: auto-inject sequential-thinking) ───────────────────
// Byte-preserving splice engine (see adapters/core.ts injectMcpEntryAt):
// comments, whitespace and unrelated content in the target file are preserved
// byte-for-byte. Only the new entry (and the comma it needs) is added.
// Signature and behavior unchanged since v1.1.8.
export function injectMcpEntry(
  path: string,
  entry: InjectableEntry,
): { ok: true; path: string } | { ok: false; error: string } {
  return injectMcpEntryAt(path, entry);
}

export interface InjectableEntry {
  name: string;
  type?: string;
  command: string[];
  /** When true, writes command (string) + args (array) for Cline compatibility. */
  clineFormat?: boolean;
  /** When set (clineFormat only), stored as Cline's `disabled` boolean. */
  disabled?: boolean;
}

/** Paths where a user-confirmed MCP entry (e.g. sequential-thinking) should
 *  be injected: the first EXISTING opencode config wins; otherwise fall back
 *  to the primary global path. */
export function pickOpenCodeConfigPath(): string {
  return pickOwnerConfigPath('opencode', join(h, '.config', 'opencode', 'opencode.jsonc'));
}

/** Paths where a user-confirmed MCP entry (e.g. playwright) should be injected
 *  for Cline: the first EXISTING cline JSON config wins; otherwise fall back
 *  to the primary global path (the VS Code Cline extension's
 *  cline_mcp_settings.json). Directories (e.g. ~/.cline/data — the Cline CLI's
 *  SQLite data dir) are skipped because they are not flat JSON files. */
export function pickClineConfigPath(): string {
  const fs = getFs();
  for (const p of CONFIG_PATHS) {
    if (p.type !== 'cline' || !fs.existsSync(p.path)) continue;
    // Skip directories — ~/.cline/data is the Cline CLI SQLite data dir, not a
    // JSON config file (the data-dir entry stays registered as a detection
    // signal; only flat JSON files are rewritable).
    try {
      if ((fs.statSync(p.path) as { isDirectory?: () => boolean }).isDirectory?.()) continue;
    } catch { /* treat as file */ }
    return p.path;
  }
  // Fall back to the VS Code Cline extension's global settings file.
  return osConfigDir('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
}

/** Playwright MCP server entry — see InjectableEntry.clineFormat. */
export const PLAYWRIGHT_MCP: InjectableEntry = {
  name: 'playwright',
  type: 'stdio',
  command: ['npx', '-y', '@playwright/mcp@latest'],
  clineFormat: true,
};
