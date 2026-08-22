import type { AgentAdapter, ConfigReadResult, McpEntry } from './types.js';
import { readdirSync as lsDir } from 'fs';
import { join, basename } from 'path';
import {
  getFs,
  readConfigPath,
  specsForOwner,
  injectMcpEntryAt,
  pickOwnerConfigPath,
  h,
  type InjectableEntry,
} from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// BaseAgentAdapter — the shared behavior every adapter inherits.
//
// Reading goes through core.readConfigPath — the per-path pipeline extracted
// verbatim from config-fetch.ts (never throws; reports exists/mtimeMs/
// parseError; treats directories as detected-but-empty, e.g. Cline CLI's
// ~/.cline/data; defers yaml/toml to the YAML discovery path).
//
// Subclasses declare their owner id (→ ordered candidate paths from
// MASTER_PATH_SPECS) and their write policy. The default write/restore pair
// is for JSON-file agents: byte-preserving splice + timestamped backup.
// Storage that must not be rewritten overrides them with logged no-ops.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdapterPathSpec {
  path: string;
  name: string;
  type: string;
  icon?: string;
  dataPath?: string;
}

/** mtimeMs of config files WE last wrote via adapter write/restore. The
 *  install-gap heuristic in index.ts skips paths we wrote ourselves. */
export const adapterSelfWritten = new Map<string, number>();

export function noteAdapterSelfWrite(path: string): void {
  try {
    adapterSelfWritten.set(path, getFs().statSync(path).mtimeMs);
  } catch {
    adapterSelfWritten.delete(path);
  }
}

export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract name: string;
  /** Owner id in MASTER_PATH_SPECS — the ordered candidate list comes from there. */
  protected abstract owner(): string;
  /** Storage label for ConfigReadResult.type. */
  protected storageType(): 'json' | 'jsonc' | 'sqlite' | 'unknown' {
    return 'json';
  }

  /** Ordered candidate paths for this agent (from MASTER_PATH_SPECS). */
  specs(): AdapterPathSpec[] {
    return specsForOwner(this.owner() as never).map((s) => ({
      path: s.path,
      name: s.name,
      type: s.type,
      icon: s.icon,
      dataPath: s.dataPath,
    }));
  }

  watchPaths(): string[] {
    return this.specs().map((s) => s.path);
  }

  /** The agent's primary config path: first EXISTING candidate, or the first
   *  canonical candidate when nothing exists yet. */
  primaryPath(): string {
    const fs = getFs();
    const specs = this.specs();
    for (const s of specs) {
      try {
        if (fs.existsSync(s.path)) return s.path;
      } catch { /* treat as missing */ }
    }
    return specs[0]?.path ?? '';
  }

  read(): ConfigReadResult {
    return this.readPath(this.primaryPath());
  }

  /**
   * Read ONE candidate path through the shared pipeline. Never throws.
   * Ported verbatim from config-fetch.ts fetchMcpsFromConfig (via core).
   */
  readPath(path: string): ConfigReadResult {
    const res = readConfigPath(path);
    return {
      path,
      name: this.name,
      type: this.storageType(),
      exists: res.exists,
      entries: res.entries,
      ...(res.mtimeMs !== undefined ? { mtimeMs: res.mtimeMs } : {}),
      ...(res.parseError ? { parseError: res.parseError } : {}),
    };
  }

  /**
   * Rewrite this agent's primary config so `proxyEntries` point at the proxy.
   * Default implementation: byte-preserving splice via injectMcpEntryAt —
   * idempotent by refusal (an entry that already exists is reported, not
   * duplicated). Adapters whose storage must not be rewritten override this
   * with a logged no-op.
   */
  write(proxyEntries: McpEntry[]): { rewritten: string[]; error?: string } {
    const target = this.primaryPath();
    if (!target || !getFs().existsSync(target)) {
      return { rewritten: [], error: `No existing config file found for ${this.name}` };
    }
    const rewritten: string[] = [];
    for (const e of proxyEntries) {
      const entry: InjectableEntry = {
        name: e.name,
        ...(e.type ? { type: e.type } : {}),
        command: e.command ?? [],
        url: e.url,
        env: e.env,
        clineFormat: this.name.toLowerCase().includes('cline'),
        enabled: e.enabled !== false,
      };
      const res = injectMcpEntryAt(target, entry);
      if (!res.ok) return { rewritten, error: res.error };
      rewritten.push(e.name);
    }
    noteAdapterSelfWrite(target);
    return { rewritten };
  }

  /**
   * Restore the primary config from the most recent `.cf-adapter-backup-*`
   * sibling written by backupCurrent(). No-op (ok:true) for adapters whose
   * write() is a no-op — they never create backups.
   */
  restore(): { ok: boolean; error?: string } {
    try {
      const fs = getFs();
      const target = this.primaryPath();
      if (!target) return { ok: false, error: `No known config path for ${this.name}` };
      // Backup listings use the real fs: backups are our own on-disk
      // artifacts, never part of the virtual-fs test surface.
      let names: string[] = [];
      try {
        names = lsDir(join(target, '..'));
      } catch {
        names = [];
      }
      const backups = names
        .filter((n) => n.startsWith(`${basename(target)}.cf-adapter-backup-`))
        .sort();
      if (backups.length === 0) return { ok: false, error: `No adapter backup found for ${target}` };
      const backupPath = join(target, '..', backups[backups.length - 1]);
      const bytes = fs.readFileSync(backupPath, 'utf-8');
      fs.writeFileSync(target, bytes);
      noteAdapterSelfWrite(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Snapshot the current primary config before a rewrite (restore source). */
  protected backupCurrent(): string | null {
    try {
      const fs = getFs();
      const target = this.primaryPath();
      if (!target || !fs.existsSync(target)) return null;
      const bytes = fs.readFileSync(target, 'utf-8');
      const backupPath = `${target}.cf-adapter-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.writeFileSync(backupPath, bytes);
      return backupPath;
    } catch {
      return null;
    }
  }
}
