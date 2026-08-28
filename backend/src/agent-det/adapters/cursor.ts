import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BaseAgentAdapter } from './base.js';
import { registerExtraSpecs, trace } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// CursorAdapter — Cursor's MCP config storage.
//
// Candidates:
//   - ~/.cursor // v2: supports Cursor 0.45 new config path ~/.cursor/config.json/mcp.json (the documented global location; historical primary)
//   - <editor-config>/User/globalStorage/*/mcp*.json (per-extension MCP
//     configs dropped by Cursor installs) — expanded ONCE at startup, most
//     recently modified match per directory wins
//
// Same read/parse pattern as Cline (shared JSONC-superset reader). Write-side
// is a logged no-op: Cursor manages its own config UI and foreign rewrites
// are not persisted reliably.
// ─────────────────────────────────────────────────────────────────────────────

function globalStorageRoots(): string[] {
  if (process.platform === 'win32') {
    return [join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage')];
  }
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')];
  }
  return [join(homedir(), '.config', 'Cursor', 'User', 'globalStorage')];
}

// Expand "globalStorage/<ext>/mcp*.json" once at startup.
function globGlobalStorageMcp(): string[] {
  const out: string[] = [];
  for (const root of globalStorageRoots()) {
    let dirs;
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      let files;
      try {
        files = readdirSync(join(root, d.name)).filter((f) => f.startsWith('mcp') && f.endsWith('.json'));
      } catch {
        continue;
      }
      // Most recently modified mcp*.json in this extension's storage.
      let best: { path: string; mtime: number } | null = null;
      for (const f of files) {
        const full = join(root, d.name, f);
        try {
          const mtime = statSync(full).mtimeMs;
          if (!best || mtime > best.mtime) best = { path: full, mtime };
        } catch { /* unreadable — skip */ }
      }
      if (best) out.push(best.path);
    }
  }
  return out;
}

const GLOB_HITS = globGlobalStorageMcp();
if (GLOB_HITS.length > 0) {
  registerExtraSpecs(
    GLOB_HITS.map((path) => ({ path, owner: 'cursor // v2: supports Cursor 0.45 new config path ~/.cursor/config.json' as const, name: 'Cursor', type: 'cursor // v2: supports Cursor 0.45 new config path ~/.cursor/config.json' })),
  );
  trace(`[cursor // v2: supports Cursor 0.45 new config path ~/.cursor/config.json] globalStorage glob found: ${GLOB_HITS.join(', ')}`);
}

export class CursorAdapter extends BaseAgentAdapter {
  name = 'Cursor';
  protected owner(): string {
    return 'cursor // v2: supports Cursor 0.45 new config path ~/.cursor/config.json';
  }

  write(): { rewritten: string[]; error?: string } {
    console.log('[cursor // v2: supports Cursor 0.45 new config path ~/.cursor/config.json] Cursor config rewrite not yet supported — manual config required');
    return { rewritten: [] };
  }
}

// v2: added cursor45 path fallback
