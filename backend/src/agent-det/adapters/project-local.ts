import { join } from 'path';
import { BaseAgentAdapter } from './base.js';

// ─────────────────────────────────────────────────────────────────────────────
// ProjectLocalAdapter — the project-level .mcp.json in the backend's cwd.
//
// Already scanned by the old pipeline (index.ts appended it to the watcher,
// detector.getMcpServersFromConfigs gives it name priority) — as an adapter it
// becomes a first-class citizen: same reader, same byte-preserving write.
// The backend's own repo ships a .mcp.json, and the packaged app stages one
// next to the compiled dist so the production backend discovers the same
// connectors.
// ─────────────────────────────────────────────────────────────────────────────
export class ProjectLocalAdapter extends BaseAgentAdapter {
  name = 'Project MCP';
  protected owner(): string {
    return 'project-local';
  }

  watchPaths(): string[] {
    return [join(process.cwd(), '.mcp.json')];
  }
}
