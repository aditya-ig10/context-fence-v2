import { join } from 'path';
import { BaseAgentAdapter } from './base.js';
import { pickOwnerConfigPath, h } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// OpenCodeAdapter — opencode's JSONC config (comments + trailing commas).
//
// Candidate order (first existing wins as primary): the global .config and
// .opencode locations, then home- and cwd-relative flat files. The no-`c`
// opencode.json variants are scanned too (A4): `npx shadcn@latest mcp init
// --client opencode` has been observed writing opencode.json instead of
// opencode.jsonc, silently dropping the entry from the UI.
//
// write() uses the byte-preserving splice engine (core.ts — the same code
// injectMcpEntry() has always used), so comments and formatting survive.
// ─────────────────────────────────────────────────────────────────────────────
export class OpenCodeAdapter extends BaseAgentAdapter {
  name = 'OpenCode';
  protected owner(): string {
    return 'opencode';
  }
  protected override storageType(): 'json' | 'jsonc' | 'sqlite' | 'unknown' {
    return 'jsonc';
  }

  /** First EXISTING opencode config; falls back to the primary global path.
   *  (This is pickOpenCodeConfigPath()'s engine — see config-fetch.ts.) */
  primaryPath(): string {
    return pickOwnerConfigPath('opencode', join(h, '.config', 'opencode', 'opencode.jsonc'));
  }
}
