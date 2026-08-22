import { Router } from 'express';
import db from '../db/index.js';
import { getPolicy } from '../policy/engine.js';
import { getMergedPolicies } from './policies.js';
import { detectAgents } from '../agent-det/detector.js';
import { getProtectedAgents } from '../protect/rewriter.js';

const router = Router();

// Top Threats — grouped by RULE NAME, not raw reason text. A rule edited
// during the period records multiple distinct reason strings (original,
// "GUI-EDITED: …", "OVERRIDDEN: … (edited)") that are ONE rule from the
// user's perspective, so the card shows a single row per rule with the
// summed count and keeps the per-reason history as expandable variants.
// Each deny row is resolved to the rule that produced it by:
//   1. exact reason match against a merged rule's reason (case-insensitive)
//   2. normalized match: strip the edit-flow markers — 'GUI-EDITED: ' /
//      'OVERRIDDEN: ' prefixes and ' (edited)' suffix — then re-compare
//   3. unique-rule-by-tool fallback: if exactly one deny rule lists the
//      row's tool, that rule is the producer (covers historical rows whose
//      reason text no longer matches any current rule, e.g. after restore)
// Rows that resolve to nothing group under their own reason text.
function groupTopThreats(rows: { reason: string; tool: string; count: number }[]) {
  const rules = getMergedPolicies();
  const reasonIndex = rules
    .filter((r) => r.reason)
    .map((r) => ({ name: r.name, reason: r.reason.toLowerCase().trim() }));
  const normalize = (s: string): string =>
    s
      .replace(/^(GUI-EDITED|OVERRIDDEN):\s*/i, '')
      .replace(/\s*\(edited\)\s*$/i, '')
      .toLowerCase()
      .trim();

  const resolveRule = (reason: string, tool: string): string | null => {
    const low = reason.toLowerCase().trim();
    const exact = reasonIndex.find((r) => r.reason === low);
    if (exact) return exact.name;
    const norm = normalize(reason);
    if (norm !== low) {
      const byNorm = reasonIndex.find((r) => r.reason === norm);
      if (byNorm) return byNorm.name;
    }
    // Context-filter denials are their own category: the fixed reason string
    // never matches a named rule, and the tool fallback below would otherwise
    // mislabel a secret-leak denial on http_request as block-env-exfil.
    if (low.startsWith('context filter:')) return 'context-filter';
    // Env-context block (Settings → "Block env/API/JWT MCP calls") has a
    // fixed agent-facing message; group it under its own rule name too.
    if (low.startsWith('contextfence:')) return 'block-env-context';
    const toolRules = rules.filter(
      (r) => r.action === 'deny' && (r.tools ?? []).some((t) => t.toLowerCase() === tool.toLowerCase()),
    );
    if (toolRules.length === 1) return toolRules[0].name;
    return null;
  };

  const grouped = new Map<string, { total: number; variants: Map<string, number> }>();
  for (const row of rows) {
    const name = resolveRule(row.reason, row.tool) ?? row.reason;
    let g = grouped.get(name);
    if (!g) {
      g = { total: 0, variants: new Map() };
      grouped.set(name, g);
    }
    g.total += row.count;
    g.variants.set(row.reason, (g.variants.get(row.reason) ?? 0) + row.count);
  }

  return [...grouped.entries()]
    .map(([name, g]) => ({
      name,
      total: g.total,
      variants: [...g.variants.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
}

router.get('/summary', (_req, res) => {
  try {
    const enabledRow = db
      .prepare("SELECT value FROM settings WHERE key = 'firewall_enabled'")
      .get() as { value: string } | undefined;
    const enabled = enabledRow ? enabledRow.value !== 'false' : true;

    const totalCalls = (db.prepare('SELECT COUNT(*) as n FROM audit_log').get() as { n: number }).n;
    const blockedCalls = (db
      .prepare("SELECT COUNT(*) as n FROM audit_log WHERE decision = 'deny'")
      .get() as { n: number }).n;
    const blockRate = totalCalls > 0 ? `${((blockedCalls / totalCalls) * 100).toFixed(1)}%` : '0%';

    const threatRows = db
      .prepare(
        `SELECT reason, tool, COUNT(*) as count
         FROM audit_log
         WHERE decision = 'deny' AND timestamp >= datetime('now', '-7 days')
         GROUP BY reason, tool`,
      )
      .all() as { reason: string; tool: string; count: number }[];

    const connectedServices = db
      .prepare('SELECT name, type, url, command, connected, last_check FROM mcp_servers WHERE removed = 0 ORDER BY name')
      .all() as { name: string; type: string; url: string | null; command: string | null; connected: number; last_check: string | null }[];

    const recentActivity = db
      .prepare(
        `SELECT id, timestamp, agent, tool, method, decision, reason, duration_ms
         FROM audit_log
         ORDER BY timestamp DESC
         LIMIT 20`,
      )
      .all() as { id: string; timestamp: string; agent: string; tool: string; method: string; decision: string; reason: string | null; duration_ms: number }[];

    // P12 (N7): honest coverage numbers — how many detected agents are
    // actually rewired through the proxy vs merely detected. The UI must
    // never imply "all protected" when most agents still bypass the fence.
    const detectedAgents = detectAgents();
    const protectedTypes = new Set(getProtectedAgents().map((p) => p.type));
    const protection = {
      detected: detectedAgents.length,
      protected: detectedAgents.filter((a) => protectedTypes.has(a.type)).length,
    };

    res.json({
      enabled,
      stats: { calls: totalCalls, blocked: blockedCalls, blockRate },
      activeRules: getPolicy().rules.length,
      uptime: Math.round(process.uptime()),
      topThreats: groupTopThreats(threatRows),
      connectedServices,
      recentActivity,
      protection,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch firewall summary' });
  }
});

export default router;
