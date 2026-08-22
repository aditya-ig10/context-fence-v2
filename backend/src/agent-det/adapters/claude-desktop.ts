import { BaseAgentAdapter } from './base.js';

// ─────────────────────────────────────────────────────────────────────────────
// ClaudeDesktopAdapter — Claude Desktop's claude_desktop_config.json.
//
// Platform candidates (first existing wins): macOS ~/Library/Application
// Support/Claude, Windows %APPDATA%\Claude, Linux ~/.config/Claude — plus the
// ~/.config/claude lowercase variant that has been observed in the wild.
// Plain JSON with an `mcpServers` container; the shared JSONC-tolerant reader
// handles it verbatim.
// ─────────────────────────────────────────────────────────────────────────────
export class ClaudeDesktopAdapter extends BaseAgentAdapter {
  name = 'Claude Desktop';
  protected owner(): string {
    return 'claude-desktop';
  }
}
