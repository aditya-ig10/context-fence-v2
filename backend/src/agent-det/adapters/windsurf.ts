import { BaseAgentAdapter } from './base.js';

// ─────────────────────────────────────────────────────────────────────────────
// WindsurfAdapter — Windsurf (Codeium) MCP config files.
//
// Candidates: ~/.codeium/windsurf/mcp_config.json (documented location) and
// ~/.windsurf/mcp.json. Plain `mcpServers` JSON. Write-side is a logged
// no-op (Windsurf regenerates this file from its own settings UI).
// ─────────────────────────────────────────────────────────────────────────────
export class WindsurfAdapter extends BaseAgentAdapter {
  name = 'Windsurf';
  protected owner(): string {
    return 'windsurf';
  }

  write(): { rewritten: string[]; error?: string } {
    console.log('[windsurf] Windsurf config rewrite not yet supported — manual config required');
    return { rewritten: [] };
  }
}
