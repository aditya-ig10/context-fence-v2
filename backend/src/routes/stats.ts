import { Router } from 'express';
import db from '../db/index.js';
import { PROXY_PORT } from '../mcp/proxy.js';
import { getMergedPolicies } from './policies.js';
import { detectAgents, hydrateAllAgentStats } from '../agent-det/detector.js';

function safeTimestamp(ts: unknown): number {
  const n = Number(ts);
  return isNaN(n) ? 0 : n;
}

const router = Router();

router.get('/', (_req, res) => {
  try {
    const totalCalls = (db.prepare('SELECT COUNT(*) as n FROM audit_log').get() as { n: number }).n;
    const blockedCalls = (db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE decision = 'deny'").get() as { n: number }).n;
    // Detected coding agents (the concept the Agents page shows), not the
    // separate `agents` table (registered API-key clients).
    const agentCount = (db.prepare("SELECT COUNT(*) as n FROM detected_agents WHERE status = 'active'").get() as { n: number }).n;
    // Merged rule count (custom_policies + context-fence.yaml file rules),
    // mirroring the count GET /api/policies reports — not a settings row
    // that is never written.
    const policyCount = getMergedPolicies().length;
    const servers = db.prepare("SELECT name FROM mcp_servers WHERE connected = 1").all() as { name: string }[];

    const blockRate = totalCalls > 0
      ? `${((blockedCalls / totalCalls) * 100).toFixed(1)}%`
      : '0%';

    // Daily snapshot history (14-day window) derived from audit_log, so the
    // dashboard can compute real week-over-week deltas.
    db.prepare(
      `INSERT OR REPLACE INTO stats_history (date, calls, blocked)
       SELECT date(timestamp), COUNT(*), SUM(CASE WHEN decision = 'deny' THEN 1 ELSE 0 END)
       FROM audit_log
       WHERE timestamp >= date('now', '-13 days')
       GROUP BY date(timestamp)`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO stats_history (date, calls, blocked) VALUES (?, 0, 0)`,
    ).run(new Date().toISOString().slice(0, 10));
    const history = db
      .prepare(
        `SELECT date, calls, blocked FROM stats_history WHERE date >= date('now', '-13 days') ORDER BY date`,
      )
      .all() as { date: string; calls: number; blocked: number }[];

    // Uptime in seconds
    const uptime = Math.round(process.uptime());

    res.json({
      uptime,
      agents: agentCount,
      servers: servers.map((s) => s.name),
      policies: policyCount,
      proxyPort: PROXY_PORT,
      history,
      calls: {
        total: totalCalls,
        blocked: blockedCalls,
        blockRate,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Policy Enforcement Timeline — allow/deny/log counts per hour over the last
// 24h, straight from audit_log (answers "is the firewall doing anything").
// Also supports ?period=today|7d|30d for the Calls Over Time chart:
//   today: hourly buckets from the start of the current calendar day
//   7d/30d: daily buckets over the last N days
// Each bucket carries allow/deny (and log) counts; the calls chart plots
// allow vs deny, the raw period-less shape is kept for backward compat.
router.get('/timeline', (req, res) => {
  try {
    const period = (req.query.period as string | undefined) || '24h';

    if (period === 'today') {
      // The audit log's timestamps are UTC (SQLite datetime('now')), but the
      // chart's x-axis should read the machine's local wall time. Query from
      // LOCAL start-of-day (converted to the matching UTC instant) and bucket
      // every row by its local hour-of-day so the labels track the system clock.
      const now = new Date();
      const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const fromUtc = localMidnight.toISOString().slice(0, 19).replace('T', ' ');

      const rows = db
        .prepare(
          `SELECT strftime('%Y-%m-%d %H', timestamp) as hourKey, decision, COUNT(*) as count
           FROM audit_log
           WHERE timestamp >= ?
           GROUP BY hourKey, decision`,
        )
        .all(fromUtc) as { hourKey: string; decision: 'allow' | 'deny' | 'log'; count: number }[];

      // One bucket per complete + current local hour, in local wall time.
      const buckets: { label: string; allow: number; deny: number; log: number }[] = [];
      const currentHour = now.getHours();
      for (let h = 0; h <= currentHour; h++) {
        buckets.push({ label: `${h}:00`, allow: 0, deny: 0, log: 0 });
      }
      const hourIndex = new Map(buckets.map((b, i) => [b.label, i]));
      for (const r of rows) {
        // hourKey is a UTC wall string (e.g. "2026-08-24 09"). Parse it as a UTC
        // instant, then getHours() maps it to the machine's local hour-of-day.
        const utc = new Date(`${r.hourKey.replace(' ', 'T')}:00Z`);
        const idx = hourIndex.get(`${utc.getHours()}:00`);
        if (idx !== undefined) buckets[idx][r.decision] = r.count;
      }
      res.json({ buckets, window: 'today' });
      return;
    }

    if (period === '7d' || period === '30d') {
      const days = period === '7d' ? 6 : 29;
      const rows = db
        .prepare(
          `SELECT date(timestamp) as day, decision, COUNT(*) as count
           FROM audit_log
           WHERE timestamp >= datetime('now', ?)
           GROUP BY day, decision`,
        )
        .all(`-${days} days`) as { day: string; decision: 'allow' | 'deny' | 'log'; count: number }[];

      // Day keys come from the UTC date (SQLite date(timestamp) is UTC) —
      // iterating backwards from "now" in UTC keeps keys aligned with rows.
      const nowMs = Date.now();
      const buckets: { label: string; allow: number; deny: number; log: number }[] = [];
      const dayToBucket = new Map<string, { label: string; allow: number; deny: number; log: number }>();
      for (let i = days; i >= 0; i--) {
        const d = new Date(nowMs - i * 86400000);
        const bucket = {
          label: period === '7d'
            ? d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
          allow: 0, deny: 0, log: 0,
        };
        buckets.push(bucket);
        dayToBucket.set(d.toISOString().slice(0, 10), bucket);
      }
      for (const r of rows) {
        const bucket = dayToBucket.get(r.day);
        if (bucket) bucket[r.decision] = r.count;
      }
      res.json({ buckets, window: period });
      return;
    }

    // Default: last-24h hourly (original shape).
    const rows = db
      .prepare(
        `SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, decision, COUNT(*) as count
         FROM audit_log
         WHERE timestamp >= datetime('now', '-24 hours')
         GROUP BY hour, decision`,
      )
      .all() as { hour: number; decision: 'allow' | 'deny' | 'log'; count: number }[];

    const buckets: { hour: number; label: string; allow: number; deny: number; log: number }[] = [];
    const currentHour = new Date().getHours();
    for (let i = 23; i >= 0; i--) {
      const hour = ((currentHour - i) % 24 + 24) % 24;
      buckets.push({ hour, label: `${hour}:00`, allow: 0, deny: 0, log: 0 });
    }
    for (const r of rows) {
      const bucket = buckets.find((b) => b.hour === r.hour);
      if (bucket) bucket[r.decision] = r.count;
    }
    res.json({ buckets, window: 'last-24h' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch timeline' });
  }
});

// Policy Outcomes Breakdown — allow/deny/log counts for a configurable window
// (this-month default; 7d / all for the Dashboard customization), plus the
// previous window's allow rate so the card can show a real trend. Categories
// map 1:1 to audit_log decisions; there is no "skipped" decision in the
// schema (the only paths are allow/deny/log, and a no-rule-match is an allow,
// not a skip) so a 4th category is NOT fabricated.
router.get('/outcomes', (req, res) => {
  try {
    const window = (req.query.window as string | undefined) || 'this-month';

    // Window boundaries; prev window is the same length immediately before.
    let startMod: string;
    let prevStartMod: string;
    let prevEndMod: string;
    if (window === '7d') {
      startMod = '-7 days';
      prevStartMod = '-14 days';
      prevEndMod = '-7 days';
    } else if (window === 'all') {
      // All-time has no previous window -> trend is null by construction.
      startMod = '-100 years';
      prevStartMod = '-100 years';
      prevEndMod = '-100 years';
    } else {
      startMod = 'start of month';
      prevStartMod = 'start of month, -1 month';
      prevEndMod = 'start of month';
    }

    const thisWindow = db
      .prepare(
        `SELECT decision, COUNT(*) as count FROM audit_log
         WHERE timestamp >= datetime('now', ?)
         GROUP BY decision`,
      )
      .all(startMod) as { decision: 'allow' | 'deny' | 'log'; count: number }[];
    const prevWindow = window === 'all'
      ? []
      : db
          .prepare(
            `SELECT decision, COUNT(*) as count FROM audit_log
             WHERE timestamp >= datetime('now', ?) AND timestamp < datetime('now', ?)
             GROUP BY decision`,
          )
          .all(prevStartMod, prevEndMod) as { decision: 'allow' | 'deny' | 'log'; count: number }[];

    const buckets = { allow: 0, deny: 0, log: 0 };
    const prev = { allow: 0, deny: 0, log: 0 };
    for (const r of thisWindow) buckets[r.decision] = r.count;
    for (const r of prevWindow) prev[r.decision] = r.count;

    const total = buckets.allow + buckets.deny + buckets.log;
    const prevTotal = prev.allow + prev.deny + prev.log;
    const allowRate = total > 0 ? (buckets.allow / total) * 100 : 0;
    const prevAllowRate = prevTotal > 0 ? (prev.allow / prevTotal) * 100 : null;

    res.json({
      window,
      buckets,
      total,
      allowRate: Number(allowRate.toFixed(1)),
      prevAllowRate: prevAllowRate === null ? null : Number(prevAllowRate.toFixed(1)),
      trend: prevAllowRate === null ? null : Number((allowRate - prevAllowRate).toFixed(1)),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch outcomes' });
  }
});

// System Health Metrics — five axes, each a real computation over audit_log
// (+ policy rules for coverage). The two radar series are decision-scoped:
// ALLOWED = rows where decision='allow', BLOCKED = rows where decision='deny'
// (same 5 axis definitions, applied to each subset over the current 24h).
//   latency     : inverse of avg duration_ms, ceiling 1000ms → 0.6s avg = 40
//   throughput  : calls/minute normalized against a 60 calls/min ceiling.
//                 On a low-traffic dev instance the rate is tiny (39 calls/24h
//                 ≈ 0.03 cpm → ~0), which is the TRUE rate vs the ceiling —
//                 the axis is kept so the radar always shows its full 5-spoke
//                 scale; samples are still reported per axis for annotation.
//   reliability : 1 - (proxy-level failure rows / rows); policy denies are
//                 working-as-intended, only forward/spawn/timeout failures
//                 count against this (reason markers are the proxy's own).
//                 Proxy failures are ALWAYS recorded as deny rows, so the
//                 Allowed series is trivially 100 by construction — all the
//                 signal sits on the Blocked side; stated, not hidden.
//   coverage    : share of distinct observed tools that appear in ≥1 rule's
//                 tools list. Coverage is about RULE PRESENCE over the tool
//                 inventory, not about a decision outcome — the value is
//                 identical on both series by design (documented, not fake).
//   efficiency  : share of a decision's rows raised by a specific NAMED rule
//                 (explicit allow/deny rule) vs the generic paths ('No
//                 matching rule' allows / 'Context filter:' denies).
router.get('/health', (_req, res) => {
  try {
    const PROXY_FAILURE_REASONS =
      "reason = 'MCP server timeout' OR reason = 'MCP server exited' OR reason = 'No MCP server running' OR reason = 'MCP server stdin is closed' OR reason LIKE 'forward failed:%'";

    // Helper: rows with timestamp >= datetime('now', <modifier>). The
    // modifier is always passed as the SECOND datetime() arg — a bare
    // datetime('-24 hours') is NULL in SQLite and would silently match nothing.
    const count = (modifier: string): number =>
      (db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE timestamp >= datetime('now', ?)").get(modifier) as { n: number }).n;
    const countWhere = (modifier: string, where: string): number =>
      (db.prepare(`SELECT COUNT(*) as n FROM audit_log WHERE timestamp >= datetime('now', ?) AND ${where}`).get(modifier) as { n: number }).n;
    const avgLatency = (modifier: string, decision: 'allow' | 'deny'): number | null =>
      (db.prepare("SELECT AVG(duration_ms) as a FROM audit_log WHERE timestamp >= datetime('now', ?) AND decision = ?").get(modifier, decision) as { a: number | null }).a;

    const LATENCY_CEILING_MS = 1000;
    const THROUGHPUT_CEILING_CPM = 60;
    const W = '-24 hours';
    const score = (v: number) => Number(Math.max(0, Math.min(100, v)).toFixed(1));

    // Every axis is always scored over the 24h window (the radar keeps its
    // full 5-spoke scale for both decision series). Sample counts are still
    // reported per axis so consumers can annotate thin data.
    const MIN_SAMPLES: Record<string, number> = {
      latency: 0,
      throughput: 0,
      reliability: 0,
      efficiency: 0,
      coverage: 0,
    };
    const rowsOf = (d: 'allow' | 'deny'): number => countWhere(W, `decision = '${d}'`);
    const gate = (axis: string, d: 'allow' | 'deny', value: number): number | null => {
      const min = MIN_SAMPLES[axis] ?? 0;
      if (min > 0 && rowsOf(d) < min) return null;
      return value;
    };

    const axes: { key: string; label: string; allowed: number | null; blocked: number | null; minSamples: number; samples: { allowed: number; blocked: number } }[] = [];

    // Latency — lower average duration = higher score. 1000ms+ → 0.
    {
      const latencyScore = (d: 'allow' | 'deny') => {
        const avg = avgLatency(W, d);
        return avg === null ? 100 : score(100 - avg / 10);
      };
      axes.push({ key: 'latency', label: 'Latency', allowed: gate('latency', 'allow', latencyScore('allow')), blocked: gate('latency', 'deny', latencyScore('deny')), minSamples: MIN_SAMPLES.latency, samples: { allowed: rowsOf('allow'), blocked: rowsOf('deny') } });
    }

    // Reliability — proxy-level failures vs total per decision.
    {
      const reliabilityScore = (d: 'allow' | 'deny') => {
        const total = rowsOf(d);
        if (total === 0) return 100;
        return score(100 - (countWhere(W, `decision = '${d}' AND (${PROXY_FAILURE_REASONS})`) / total) * 100);
      };
      axes.push({ key: 'reliability', label: 'Reliability', allowed: gate('reliability', 'allow', reliabilityScore('allow')), blocked: gate('reliability', 'deny', reliabilityScore('deny')), minSamples: MIN_SAMPLES.reliability, samples: { allowed: rowsOf('allow'), blocked: rowsOf('deny') } });
    }

    // Throughput — per-decision calls per minute, normalized against the
    // documented ceiling. "Blocked throughput" = the rate at which the
    // firewall is stopping things; "Allowed throughput" = served call rate.
    // Always scored so the radar shows the full 5-spoke scale.
    {
      const cpm = (d: 'allow' | 'deny') => rowsOf(d) / 1440;
      const throughputScore = (d: 'allow' | 'deny') => score((cpm(d) / THROUGHPUT_CEILING_CPM) * 100);
      axes.push({ key: 'throughput', label: 'Throughput', allowed: gate('throughput', 'allow', throughputScore('allow')), blocked: gate('throughput', 'deny', throughputScore('deny')), minSamples: MIN_SAMPLES.throughput, samples: { allowed: rowsOf('allow'), blocked: rowsOf('deny') } });
    }

    // Coverage — distinct observed tools covered by a named rule's tools list.
    // Rules are global (not per-server); coverage is a property of the rule
    // SET vs the tool inventory, so it is identical on both decision series.
    {
      const observed = db.prepare('SELECT DISTINCT tool FROM audit_log').all() as { tool: string }[];
      const rules = getMergedPolicies();
      const covered = observed.filter((t) =>
        rules.some((r) => (r.tools ?? []).some((x) => x.toLowerCase() === t.tool.toLowerCase())),
      );
      const coverage = observed.length === 0 ? 100 : (covered.length / observed.length) * 100; // 0 observed tools = vacuous 100
      axes.push({ key: 'coverage', label: 'Coverage', allowed: score(coverage), blocked: score(coverage), minSamples: 0, samples: { allowed: observed.length, blocked: observed.length } });
    }

    // Efficiency — per decision, share raised by a specific named rule vs the
    // generic paths ('No matching rule' for allows, 'Context filter:' for
    // denies).
    {
      const efficiencyScore = (d: 'allow' | 'deny') => {
        const total = rowsOf(d);
        if (total === 0) return 100;
        const generic = d === 'allow'
          ? countWhere(W, "decision = 'allow' AND (reason = 'No matching rule' OR reason LIKE 'Context filter:%')")
          : countWhere(W, "decision = 'deny' AND reason LIKE 'Context filter:%'");
        return score(((total - generic) / total) * 100);
      };
      axes.push({ key: 'efficiency', label: 'Efficiency', allowed: gate('efficiency', 'allow', efficiencyScore('allow')), blocked: gate('efficiency', 'deny', efficiencyScore('deny')), minSamples: MIN_SAMPLES.efficiency, samples: { allowed: rowsOf('allow'), blocked: rowsOf('deny') } });
    }

    // Average over all 5 axes (every axis is scored), matching the polygon.
    const average = (slot: 'allowed' | 'blocked') => {
      const scored: number[] = [];
      for (const a of axes) if (a[slot] !== null) scored.push(a[slot] as number);
      if (scored.length === 0) return 0;
      return Number((scored.reduce((sum, v) => sum + v, 0) / scored.length).toFixed(1));
    };

    res.json({
      axes,
      series: {
        allowed: axes.map((a) => a.allowed),
        blocked: axes.map((a) => a.blocked),
      },
      average: { allowed: average('allowed'), blocked: average('blocked') },
      window: 'last-24h per decision',
      definitions: {
        latency: `100 - (avg duration_ms / 10), clamped 0-100; ceiling ${LATENCY_CEILING_MS}ms → 0`,
        throughput: `min(100, per-decision calls-per-minute / ${THROUGHPUT_CEILING_CPM} * 100); ceiling ${THROUGHPUT_CEILING_CPM} calls/min → 100`,
        reliability: `100 * (1 - proxy-failure rows / rows of that decision); proxy failures are always deny rows, so Allowed is trivially 100; no traffic → 100`,
        coverage: `100 * (distinct observed tools in ≥1 rule.tools / distinct observed tools); rule-presence metric, identical on both series by design; no observed tools → 100 (vacuous)`,
        efficiency: `100 * (named-rule rows / all rows of that decision); generic fallbacks are 'No matching rule' (allow) and 'Context filter:' (deny); no rows → 100`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch health metrics' });
  }
});

// Top Blocked Tools — which specific tools triggered denies most often in the
// last 7 days. Mirrors the Firewall page's Top Threats card but scoped to
// tool names instead of rule reasons.
router.get('/top-tools', (_req, res) => {
  try {
    const tools = db
      .prepare(
        `SELECT tool, COUNT(*) as count
         FROM audit_log
         WHERE decision = 'deny' AND timestamp >= datetime('now', '-7 days')
         GROUP BY tool
         ORDER BY count DESC
         LIMIT 5`,
      )
      .all() as { tool: string; count: number }[];
    res.json({ tools, window: 'last-7-days' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch top tools' });
  }
});

// Agent ↔ MCP usage — which MCP servers each agent (LLM) actually called, and
// vice versa which agents called a given server, straight from the audit log
// (every proxied call stores agent + server). Both directions are always
// returned; optional ?agent= / ?server= filters narrow the source rows:
//   GET /api/stats/mcp-usage?agent=opencode  → byAgent: the MCPs opencode used
//   GET /api/stats/mcp-usage?server=github   → byServer: every agent using github
interface McpUsageRow {
  agent: string;
  server: string;
  calls: number;
  allowed: number;
  denied: number;
  logged: number;
  tools_used: number;
  first_called: string;
  last_called: string;
}

interface McpUsageLink {
  name: string;
  calls: number;
  allowed: number;
  denied: number;
  logged: number;
  tools: number;
  firstUsed: string;
  lastUsed: string;
}

router.get('/mcp-usage', (req, res) => {
  try {
    const agentFilter = typeof req.query.agent === 'string' && req.query.agent ? req.query.agent : undefined;
    const serverFilter = typeof req.query.server === 'string' && req.query.server ? req.query.server : undefined;

    const where: string[] = ["server IS NOT NULL AND server != '' AND agent IS NOT NULL AND agent != ''"];
    const params: string[] = [];
    if (agentFilter) { where.push('agent = ?'); params.push(agentFilter); }
    if (serverFilter) { where.push('server = ?'); params.push(serverFilter); }

    const rows = db
      .prepare(
        `SELECT agent, server,
                COUNT(*) AS calls,
                SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allowed,
                SUM(CASE WHEN decision = 'deny'  THEN 1 ELSE 0 END) AS denied,
                SUM(CASE WHEN decision = 'log'   THEN 1 ELSE 0 END) AS logged,
                COUNT(DISTINCT tool) AS tools_used,
                MIN(timestamp) AS first_called,
                MAX(timestamp) AS last_called
         FROM audit_log
         WHERE ${where.join(' AND ')}
         GROUP BY agent, server
         ORDER BY calls DESC`,
      )
      .all(...params) as McpUsageRow[];

    const link = (r: McpUsageRow): McpUsageLink => ({
      name: r.server,
      calls: r.calls,
      allowed: r.allowed,
      denied: r.denied,
      logged: r.logged,
      tools: r.tools_used,
      firstUsed: r.first_called,
      lastUsed: r.last_called,
    });

    const agentMap = new Map<string, { agent: string; calls: number; servers: McpUsageLink[] }>();
    const serverMap = new Map<string, { server: string; calls: number; agents: McpUsageLink[] }>();
    for (const r of rows) {
      let a = agentMap.get(r.agent);
      if (!a) { a = { agent: r.agent, calls: 0, servers: [] }; agentMap.set(r.agent, a); }
      a.calls += r.calls;
      a.servers.push(link(r));

      let s = serverMap.get(r.server);
      if (!s) { s = { server: r.server, calls: 0, agents: [] }; serverMap.set(r.server, s); }
      s.calls += r.calls;
      s.agents.push({ ...link(r), name: r.agent });
    }

    res.json({
      byAgent: [...agentMap.values()].sort((x, y) => y.calls - x.calls),
      byServer: [...serverMap.values()].sort((x, y) => y.calls - x.calls),
      filters: { agent: agentFilter ?? null, server: serverFilter ?? null },
      source: 'audit_log',
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch MCP usage' });
  }
});

// Most Active Agent — ranked by sessions + messages across detected agent
// stats (audit_log volume is too low to rank agents by real proxy traffic,
// so the ranking uses the agents' own usage data; see final report).
router.get('/most-active', (_req, res) => {
  try {
    const agents = detectAgents();
    // Hydrate real session/message/token stats — detectAgents() alone leaves
    // stats empty (sessions/messages 0) because boot detection stays light.
    hydrateAllAgentStats(agents);
    let winner: {
      name: string;
      type: string;
      score: number;
      sessions: number;
      messages: number;
      tokensTotal: number;
    } | null = null;

    for (const a of agents) {
      const sessions = a.stats?.sessions ?? 0;
      const messages = a.stats?.messages ?? 0;
      const tokensTotal = a.stats?.tokensTotal ?? 0;
      const score = sessions + messages;
      if (!winner || score > winner.score || (score === winner.score && tokensTotal > winner.tokensTotal)) {
        winner = { name: a.name, type: a.type, score, sessions, messages, tokensTotal };
      }
    }
    res.json({ winner, metric: 'sessions + messages', source: 'detected_agents stats' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch most active agent' });
  }
});

export default router;