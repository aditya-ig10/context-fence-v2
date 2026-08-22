import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BaseAgentAdapter } from './base.js';
import { trace, registerExtraSpecs } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// ClineAdapter — fixes multi-agent detection when Cline stores its MCP config
// somewhere other than the flat global paths.
//
// Cline ships in three flavors, each with its own storage:
//   1. VSCode / VSCode Insiders / Cursor extension (GUI install):
//      <editor-config>/User/globalStorage/saoudrizwan.claude-dev/settings/
//        cline_mcp_settings.json
//   2. Cline CLI (standalone): ~/.cline/mcp_settings.json (+ .config + cwd
//      variants), plus the legacy ~/.cline/mcp.json / config.json locations,
//      plus — the LIVE file on current CLI builds —
//      ~/.cline/data/settings/cline_mcp_settings.json (PRIMARY: the CLI reads
//      this exact file at startup; it must always be tried before the data
//      DIRECTORY below, because only a flat JSON file is rewritable).
//   3. Glob fallback (run once at startup): any cline_mcp_settings.json under
//      ~/.vscode/extensions/saoudrizwan.claude-dev-/ — most recently
//      modified match wins.
//
// Format: plain JSON, `mcpServers` container, MCP-spec entries
// ({ command: string, args: string[], env, disabled }) — parsed by the shared
// extractor (JSONC tokenizer is a strict superset of JSON) with disabled
// entries dropped per contract. Write-side is intentionally log-only:
// Cline re-syncs its settings UI from its own store and a foreign rewrite can
// be silently reverted, so manual config is required for now.
// ─────────────────────────────────────────────────────────────────────────────

/** Glob fallback (once per process): most recently modified
 *  cline_mcp_settings.json under any saoudrizwan.claude-dev extension dir.
 *  Bounded walk — no deep recursion, all errors swallowed. */
function globExtensionSettings(): string[] {
  const matches: { path: string; mtime: number }[] = [];
  try {
    const extRoot = join(homedir(), '.vscode', 'extensions');
    const dirs = readdirSync(extRoot)
      .filter((d) => d.startsWith('saoudrizwan.claude-dev-'))
      .map((d) => join(extRoot, d));
    const visit = (dir: string, depth: number): void => {
      if (depth > 6) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) visit(full, depth + 1);
        else if (e.name === 'cline_mcp_settings.json') {
          try {
            matches.push({ path: full, mtime: statSync(full).mtimeMs });
          } catch { /* unreadable — skip */ }
        }
      }
    };
    for (const d of dirs) visit(d, 0);
  } catch { /* no extensions dir — fine */ }
  // Most recently modified match wins.
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches.slice(0, 1).map((m) => m.path);
}

// Run once at module load (startup), not on every read.
const GLOB_HITS = globExtensionSettings();
if (GLOB_HITS.length > 0) {
  registerExtraSpecs(
    GLOB_HITS.map((path) => ({ path, owner: 'cline' as const, name: 'Cline', type: 'cline' })),
  );
  trace(`[cline] glob fallback found: ${GLOB_HITS.join(', ')}`);
}

export class ClineAdapter extends BaseAgentAdapter {
  name = 'Cline';
  protected owner(): string {
    return 'cline';
  }

  /** Spec contract: skip disabled:true entries entirely. */
  read() {
    const res = super.read();
    res.entries = res.entries.filter((e) => e.enabled !== false);
    return res;
  }
}
