// ─────────────────────────────────────────────────────────────────────────────
// AgentAdapter — the per-agent contract for reading, watching and (where
// supported) rewriting an AI coding agent's MCP config storage.
//
// One adapter per agent/agent-family replaces the old flat CONFIG_PATHS scan:
// the registry (registry.ts) aggregates adapters so the fetch pipeline
// (config-fetch.ts), the chokidar watcher (index.ts) and the agent detector
// (detector.ts) all derive from a single source of truth.
//
// PURE module: no db, no proxy, no electron. File IO goes through the shared
// injectable fs slot (core.ts) so unit tests can run adapters against a
// virtual filesystem exactly like the old pipeline did.
// ─────────────────────────────────────────────────────────────────────────────

/** One MCP server entry as declared by an agent's config storage. */
export interface McpEntry {
  name: string;
  /** Transport as the agent labels it (`stdio`/`http`/`remote`/`local`). */
  type: 'stdio' | 'http' | 'remote' | 'local';
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Human-readable: which adapter/path found this. */
  source: string;
  /**
   * Present-and-false when the agent flags the entry off (e.g. opencode's
   * `enabled: false`). Adapters that skip disabled entries (Cline) simply
   * never emit them; generic adapters preserve the flag so downstream
   * surfaces can still show the entry exists.
   */
  enabled?: boolean;
}

/** Result of reading one agent's MCP config storage. */
export interface ConfigReadResult {
  /** Canonical path (or db path) used for this read. */
  path: string;
  /** Agent display name e.g. "Cline CLI". */
  name: string;
  type: 'json' | 'jsonc' | 'sqlite' | 'unknown';
  exists: boolean;
  entries: McpEntry[];
  /** For file-based reads: used by chokidar + install-gap detection. */
  mtimeMs?: number;
  parseError?: string;
}

/**
 * Per-agent adapter. Implementations must never throw from read()/write()/
 * restore() — every failure mode is reported in the return value so one
 * broken agent config can never take down the discovery loop.
 */
export interface AgentAdapter {
  /** Human-readable agent name. */
  name: string;

  /**
   * File path(s) to watch (chokidar). Empty array if polling-only.
   * Multiple entries when the agent has several candidate config locations;
   * order matters (first existing wins as the agent's primary config).
   */
  watchPaths(): string[];

  /** Read current MCP entries from this agent's config storage. */
  read(): ConfigReadResult;

  /**
   * Rewrite config so all MCP entries point at the Context Fence proxy.
   * Must be idempotent. Returns the list of server names rewritten.
   * Implement as no-op + log if the agent does not support config rewriting.
   */
  write(proxyEntries: McpEntry[]): { rewritten: string[]; error?: string };

  /**
   * Restore original config from backup (undo write).
   * Implement as no-op if write() is a no-op.
   */
  restore(): { ok: boolean; error?: string };
}
