import { OpenCodeAdapter } from './opencode.js';
import { ClaudeDesktopAdapter } from './claude-desktop.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { ClineAdapter } from './cline.js';
import { CursorAdapter } from './cursor.js';
import { WindsurfAdapter } from './windsurf.js';
import { AntigravityAdapter } from './antigravity.js';
import { ProjectLocalAdapter } from './project-local.js';
import type { AgentAdapter, ConfigReadResult } from './types.js';
import { allPathSpecs } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Registry — the single source of truth for agent config adapters.
//
// Consumers:
//   - config-fetch.ts derives CONFIG_PATHS + the per-path owner map from here
//   - detector.ts derives AGENT_PATHS from getAgentPathDescriptors()
//   - index.ts derives the chokidar watch list from getAllWatchPaths()
//
// Legacy agents (Codex, GitHub Copilot, Continue, Aider) have no dedicated
// adapter yet; their path specs flow through unchanged so detection and
// stats parsing keep working exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

const openCode = new OpenCodeAdapter();
const claudeDesktop = new ClaudeDesktopAdapter();
const claudeCode = new ClaudeCodeAdapter();
const cline = new ClineAdapter();
const cursor = new CursorAdapter();
const windsurf = new WindsurfAdapter();
const antigravity = new AntigravityAdapter();
const projectLocal = new ProjectLocalAdapter();

export const AGENT_ADAPTERS: AgentAdapter[] = [
  openCode,
  claudeDesktop,
  claudeCode,
  cline,
  cursor,
  windsurf,
  antigravity,
  projectLocal,
];

// Path-spec owner id → adapter instance.
const OWNER_ADAPTERS: Record<string, AgentAdapter> = {
  opencode: openCode,
  'claude-desktop': claudeDesktop,
  'claude-code': claudeCode,
  cline,
  cursor,
  windsurf,
  antigravity,
  'project-local': projectLocal,
};

/** Every file path worth watching (chokidar targets), in scan order. */
export function getAllWatchPaths(): string[] {
  return AGENT_ADAPTERS.flatMap((a) => a.watchPaths()).filter(Boolean);
}

/**
 * One read per adapter (its primary resolved config). For per-path results —
 * what the fetch pipeline and install-gap tracker need — use
 * config-fetch.fetchAllMcps()/fetchMcpsFromConfig(), which iterate every
 * candidate path through its owning adapter.
 */
export function readAllConfigs(): ConfigReadResult[] {
  return AGENT_ADAPTERS.map((a) => {
    try {
      return a.read();
    } catch (err) {
      return {
        path: 'unknown',
        name: a.name,
        type: 'unknown' as const,
        exists: false,
        entries: [],
        parseError: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/** Find the adapter that owns a given path (per-path routing). */
export function adapterForPath(path: string): AgentAdapter | null {
  for (const spec of allPathSpecs()) {
    if (spec.path === path) return OWNER_ADAPTERS[spec.owner] ?? null;
  }
  return null;
}

/** Rich descriptors (path + display metadata) for every scanned path.
 *  detector.ts builds AGENT_PATHS from this; `agent: false` marks paths that
 *  are scanned/watched but must not become detected-agent rows (the
 *  project-local .mcp.json was never an agent). */
export interface AgentPathDescriptor {
  path: string;
  name: string;
  type: string;
  icon?: string;
  dataPath?: string;
  /** False = watch/scan only, never a detected-agent row. */
  agent: boolean;
}

export function getAgentPathDescriptors(): AgentPathDescriptor[] {
  return allPathSpecs().map((s) => ({
    path: s.path,
    name: s.name,
    type: s.type,
    icon: s.icon,
    dataPath: s.dataPath,
    agent: s.type !== 'project',
  }));
}
