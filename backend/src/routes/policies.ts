import { Router } from 'express';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import db from '../db/index.js';
import { broadcast } from '../realtime/hub.js';

const router = Router();

/**
 * N6 DESIGN — Editable built-in rules (override mechanism).
 *
 * Goal: a rule shipped in context-fence.yaml ("Built-in") becomes editable
 * and re-readable in the UI, without ever rewriting the YAML file.
 *
 * Mechanism:
 *   - Editing a built-in rule writes a row into custom_policies with the
 *     SAME rule name (upsert by name). The YAML file is untouched.
 *   - getMergedPolicies() builds the YAML rule list first, then folds in
 *     custom_policies rows: a custom row whose name matches a YAML rule's
 *     name REPLACES that rule IN PLACE (same position in the list, one row
 *     per name — override, not duplicate) and is marked origin 'Modified'.
 *     A custom row whose name matches no YAML rule is appended as origin
 *     'Custom'. The merged list therefore never shows two rows with the
 *     same name.
 *   - Clash handling: custom_policies.name is UNIQUE at the schema level,
 *     and every write path is an upsert (INSERT ... ON CONFLICT(name) DO
 *     UPDATE), so two rows with the same name cannot exist. As a defensive
 *     fallback the reader sorts custom rows by id DESC so the last-written
 *     row would win if a legacy duplicate ever appeared.
 *   - Restore default: DELETE FROM custom_policies WHERE name = ? — removes
 *     only the override row; the YAML rule reverts to its file version.
 *     Restoring never touches the YAML file.
 *   - Enforcement: evaluateRequest() (policy/engine.ts) now iterates the
 *     MERGED rules (getMergedPolicies) instead of the YAML-only list, so an
 *     override's reason/action/conditions are what the engine actually
 *     evaluates — the audit_log reason proves the override is live, not
 *     just the UI display. (This also activates custom rules that were
 *     previously UI-only.)
 *   - Origins: 'Built-in' (YAML only), 'Modified' (YAML overridden by a
 *     custom_policies row), 'Custom' (custom_policies row, no YAML rule
 *     with that name).
 */

interface PolicyRule {
  id?: number;
  name: string;
  description?: string;
  action: string;
  reason: string;
  methods?: string[];
  tools?: string[];
  servers?: string[];
  param_contains?: string[];
  path_patterns?: string[];
  domain_patterns?: string[];
  custom?: boolean;
  origin?: 'Built-in' | 'Modified' | 'Custom';
}

// Merged-policy cache (EMFILE hardening): getMergedPolicies() runs inside
// evaluateRequest() on EVERY proxied request, and it used to readFileSync +
// re-parse the YAML each time — the most frequent file open in the process,
// so it was the first call to throw EMFILE once the fd ceiling was hit (e.g.
// during OAuth sync/retry storms). The merged list is now cached and rebuilt
// only when (a) the YAML's mtime changes (external edit / reload), or
// (b) a custom_policies write path invalidates it explicitly. statSync does
// not hold an fd, so the stamp check is cheap and leak-free.
let mergedCache: { stamp: string; value: PolicyRule[] } | null = null;

export function invalidateMergedPolicies(): void {
  mergedCache = null;
}

export function getMergedPolicies(): PolicyRule[] {
  const policyDir = process.env.CF_POLICY_DIR || process.cwd();
  const yamlPath = join(policyDir, 'context-fence.yaml');

  let fileStamp = 'missing';
  try {
    fileStamp = String(statSync(yamlPath).mtimeMs);
  } catch { /* no file yet */ }
  const stamp = fileStamp;
  if (mergedCache && mergedCache.stamp === stamp) return mergedCache.value;

  const built = buildMergedPolicies(yamlPath);
  mergedCache = { stamp, value: built };
  return built;
}

function buildMergedPolicies(yamlPath: string): PolicyRule[] {

  // empty lists -> undefined so the engine's `if (rule.methods)` guards treat
  // them as "no restriction" (an empty array is truthy and would force a miss)
  const list = (v: unknown): string[] | undefined => {
    const raw = Array.isArray(v)
      ? v.map(String)
      : String(v ?? '').split(',').map((s) => s.trim());
    const clean = raw.filter(Boolean);
    return clean.length > 0 ? clean : undefined;
  };

  // YAML rules first (in file order) — overrides replace them IN PLACE.
  const merged: PolicyRule[] = [];
  const yamlIndexByName = new Map<string, number>();
  if (existsSync(yamlPath)) {
    const doc = yaml.load(readFileSync(yamlPath, 'utf-8')) as { rules?: (PolicyRule & { match?: { methods?: string[]; tools?: string[]; param_contains?: string[]; path_patterns?: string[]; domain_patterns?: string[] } })[] };
    if (doc?.rules) {
      for (const r of doc.rules) {
        const rule: PolicyRule = {
          name: r.name || 'unnamed',
          description: r.description || '',
          action: r.action || 'deny',
          reason: r.reason || '',
          methods: list(r.methods ?? r.match?.methods),
          tools: list(r.tools ?? r.match?.tools),
          servers: list((r as { servers?: string[] }).servers),
          param_contains: list(r.param_contains ?? r.match?.param_contains),
          path_patterns: list(r.path_patterns ?? r.match?.path_patterns),
          domain_patterns: list(r.domain_patterns ?? r.match?.domain_patterns),
          custom: false,
          origin: 'Built-in',
        };
        yamlIndexByName.set(rule.name, merged.length);
        merged.push(rule);
      }
    }
  }

  // custom_policies rows: name matching a YAML rule = override (replace the
  // rule at its original position, keep order); otherwise append as new.
  // Sorted by id DESC so the last-written row wins if a legacy duplicate
  // ever existed (name is UNIQUE in the schema; all writes are upserts).
  const customRows = db
    .prepare('SELECT * FROM custom_policies ORDER BY id DESC')
    .all() as Record<string, unknown>[];
  for (const r of customRows) {
    const name = r.name as string;
    const rule: PolicyRule = {
      id: r.id as number,
      name,
      description: r.description as string,
      action: r.action as string,
      reason: r.reason as string,
      methods: list(r.methods),
      tools: list(r.tools),
      servers: list(r.servers),
      param_contains: list(r.param_contains),
      path_patterns: list(r.path_patterns),
      domain_patterns: list(r.domain_patterns),
      custom: true,
      origin: yamlIndexByName.has(name) ? 'Modified' : 'Custom',
    };
    const yamlIndex = yamlIndexByName.get(name);
    if (yamlIndex !== undefined) merged[yamlIndex] = rule;
    else merged.push(rule);
  }

  return merged;
}

router.get('/', (_req, res) => {
  try {
    const rules = getMergedPolicies();
    res.json({ rules, customPolicies: rules.filter(r => r.custom), fileRules: rules.filter(r => !r.custom), activeCount: rules.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch policies' });
  }
});

router.get('/status', (_req, res) => {
  try {
    const rules = getMergedPolicies();
    res.json({
      rulesLoaded: rules.length,
      logOnly: 0,
      customCount: rules.filter(r => r.custom).length,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch policy status' });
  }
});

router.post('/create', (req, res) => {
  try {
    const { name, description, action, reason, methods, tools, servers, param_contains, path_patterns, domain_patterns } = req.body as Record<string, string | undefined>;
    if (!name || !action) return res.status(400).json({ error: 'name and action required' });

    // Upsert by name: creating a rule whose name matches an existing rule
    // (custom OR YAML built-in) REPLACES that rule — this is the single
    // write path for both create and override, and name is UNIQUE in the
    // schema so it can never produce two rows with the same name.
    const stmt = db.prepare(`
      INSERT INTO custom_policies (name, description, action, reason, methods, tools, servers, param_contains, path_patterns, domain_patterns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        action = excluded.action,
        reason = excluded.reason,
        methods = excluded.methods,
        tools = excluded.tools,
        servers = excluded.servers,
        param_contains = excluded.param_contains,
        path_patterns = excluded.path_patterns,
        domain_patterns = excluded.domain_patterns
    `);
    stmt.run(name, description || '', action, reason || '', methods || '', tools || '', servers || '', param_contains || '', path_patterns || '', domain_patterns || '');
    const isOverride = getMergedPolicies().some((r) => r.name === name && r.origin === 'Modified');
    invalidateMergedPolicies();
    broadcast('policy.updated', { name });
    res.status(201).json({ ok: true, origin: isOverride ? 'Modified' : 'Custom' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create policy' });
  }
});

// Explicit override endpoint (same upsert semantics as create, named for
// the GUI's Edit flow on Built-in rules).
router.put('/:name/override', (req, res) => {
  try {
    const { description, action, reason, methods, tools, servers, param_contains, path_patterns, domain_patterns } = req.body as Record<string, string | undefined>;
    const name = decodeURIComponent(req.params.name);
    if (!name || !action) return res.status(400).json({ error: 'name and action required' });

    db.prepare(`
      INSERT INTO custom_policies (name, description, action, reason, methods, tools, servers, param_contains, path_patterns, domain_patterns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        action = excluded.action,
        reason = excluded.reason,
        methods = excluded.methods,
        tools = excluded.tools,
        servers = excluded.servers,
        param_contains = excluded.param_contains,
        path_patterns = excluded.path_patterns,
        domain_patterns = excluded.domain_patterns
    `).run(name, description || '', action, reason || '', methods || '', tools || '', servers || '', param_contains || '', path_patterns || '', domain_patterns || '');
    invalidateMergedPolicies();
    broadcast('policy.updated', { name });
    res.json({ ok: true, origin: 'Modified' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to override policy' });
  }
});

// Restore default: remove the override row so the YAML rule is effective
// again. Only touches custom_policies — the YAML file is never written.
router.post('/:name/restore', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const removed = db.prepare('DELETE FROM custom_policies WHERE name = ?').run(name);
    invalidateMergedPolicies();
    broadcast('policy.updated', { name });
    res.json({ ok: true, removed: removed.changes });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to restore policy' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM custom_policies WHERE id = ?').run(req.params.id);
    invalidateMergedPolicies();
    broadcast('policy.updated', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete policy' });
  }
});

router.put('/:id/toggle-mode', (req, res) => {
  try {
    const row = db.prepare('SELECT action FROM custom_policies WHERE id = ?').get(req.params.id) as { action: string } | undefined;
    if (!row) return res.status(404).json({ error: 'Policy not found' });

    const newAction = row.action === 'allow' ? 'deny' : 'allow';
    db.prepare('UPDATE custom_policies SET action = ? WHERE id = ?').run(newAction, req.params.id);
    invalidateMergedPolicies();
    broadcast('policy.updated', { id: req.params.id, action: newAction });
    res.json({ ok: true, action: newAction });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to toggle policy' });
  }
});

router.post('/reload', async (_req, res) => {
  try {
    const policyDir = process.env.CF_POLICY_DIR || process.cwd();
    const { loadPolicy } = await import('../policy/engine.js');
    loadPolicy(policyDir);
    broadcast('policy.updated', {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to reload policies' });
  }
});

export default router;
