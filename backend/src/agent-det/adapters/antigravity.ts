import { readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BaseAgentAdapter } from './base.js';
import { registerExtraSpecs, trace } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// AntigravityAdapter — Gemini CLI / Google Antigravity MCP configs.
//
// The agy CLI keeps its MCP servers in ~/.gemini/config/mcp_config.json under
// an `mcpServers` block with the standard MCP-spec entry shape:
//   { "mcpServers": { "<name>": { "command": "npx", "args": [...], "env": {...} } } }
// Plugin-provided servers live in ~/.gemini/config/plugins/<name>/mcp_config.json
// (expanded once at startup). The shared extractor handles both verbatim.
//
// Write-side is a logged no-op — Gemini CLI regenerates its config from its
// own state, so foreign rewrites are not persisted reliably.
// ─────────────────────────────────────────────────────────────────────────────

/** Expand "config/plugins/<name>/mcp_config.json" once at startup. */
function globPluginConfigs(): string[] {
  const out: string[] = [];
  const pluginsDir = join(homedir(), '.gemini', 'config', 'plugins');
  let dirs;
  try {
    dirs = readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const candidate = join(pluginsDir, d.name, 'mcp_config.json');
    try {
      // getFs is not needed here: this only decides which paths to REGISTER;
      // actual reads always go through the injectable fs slot.
      if (readdirSync(join(pluginsDir, d.name)).includes('mcp_config.json')) out.push(candidate);
    } catch { /* unreadable plugin dir — skip */ }
  }
  return out;
}

const GLOB_HITS = globPluginConfigs();
if (GLOB_HITS.length > 0) {
  registerExtraSpecs(
    GLOB_HITS.map((path) => ({
      path,
      owner: 'antigravity' as const,
      name: 'Gemini CLI (Antigravity)',
      type: 'gemini',
      icon: 'https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png',
    })),
  );
  trace(`[antigravity] plugin configs found: ${GLOB_HITS.join(', ')}`);
}

export class AntigravityAdapter extends BaseAgentAdapter {
  name = 'Gemini CLI (Antigravity)';
  protected owner(): string {
    return 'antigravity';
  }

  write(): { rewritten: string[]; error?: string } {
    console.log('[antigravity] Gemini CLI config rewrite not yet supported — manual config required');
    return { rewritten: [] };
  }
}
