import { BaseAgentAdapter } from './base.js';

// ─────────────────────────────────────────────────────────────────────────────
// ClaudeCodeAdapter — Claude Code CLI's JSON config files.
//
// Candidates (ALL existing ones are watch targets; read() uses the first
// existing): ~/.claude/settings.json (the long-scanned location), the newer
// ~/.claude/claude_code_config.json and ~/.claude.json, and the project-local
// .claude/settings.json. Same `mcpServers` JSON shape as Claude Desktop.
// ─────────────────────────────────────────────────────────────────────────────
export class ClaudeCodeAdapter extends BaseAgentAdapter {
  name = 'Claude Code';
  protected owner(): string {
    return 'claude-code';
  }
}
