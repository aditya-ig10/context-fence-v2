import { Router } from 'express';
import { maskSecrets } from '../policy/masking.js';
import db from '../db/index.js';
import { broadcast } from '../realtime/hub.js';

const router = Router();

router.get('/', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;
    const decision = req.query.decision as string | undefined;
    const envOnly = req.query.env === '1';

    let sql = 'SELECT * FROM audit_log';
    const params: unknown[] = [];
    const countParams: unknown[] = [];
    const conditions: string[] = [];

    if (decision && ['allow', 'deny', 'log'].includes(decision)) {
      conditions.push('decision = ?');
      params.push(decision);
      countParams.push(decision);
    }
    // Env/secret-context reads: rows raised by the env-context block or the
    // built-in secret context filter (the audit trail of env/API/JWT reads).
    if (envOnly) {
      conditions.push("(reason LIKE 'ContextFence:%' OR reason LIKE 'Context filter:%')");
    }

    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;

    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const logs = db
      .prepare(sql)
      .all(...params)
      .map((r) => {
        const row = r as Record<string, unknown>;
        // Env/secret-context marker: anything raised by the env-context block
        // ("ContextFence: …") or the built-in secret context filter. Single
        // source of truth shared with the ?env=1 filter so the UI can mark
        // these rows as soon as a session reads env/API/JWT context.
        row.env = /^(ContextFence:|Context filter:)/.test(String(row.reason ?? ''));
        return row;
      });
    const countRow = db
      .prepare(
        `SELECT COUNT(*) as n FROM audit_log${
          conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
        }`,
      )
      .get(...countParams) as { n: number };

    res.json({ logs, total: countRow.n, page, limit, filters: { decision: decision ?? null, env: envOnly } });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch logs' });
  }
});

router.get('/export', (req, res) => {
  try {
    const decision = req.query.decision as string | undefined;
    const format = req.query.format as string || 'json';

    let sql = 'SELECT * FROM audit_log';
    const params: unknown[] = [];

    if (decision && ['allow', 'deny', 'log'].includes(decision)) {
      sql += ' WHERE decision = ?';
      params.push(decision);
    }

    sql += ' ORDER BY timestamp DESC';
    const logs = db.prepare(sql).all(...params);

    if (format === 'csv') {
      const header = 'id,timestamp,agent,tool,method,decision,reason,duration_ms,session_id';
      const rows = (logs as Record<string, unknown>[]).map(r =>
        [r.id, r.timestamp, r.agent, r.tool, r.method, r.decision, r.reason, r.duration_ms, r.session_id]
          .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
      );
      res.setHeader('Content-Type', 'text/csv');
      res.send([header, ...rows].join('\n'));
    } else {
      res.json({ logs });
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to export logs' });
  }
});

router.post('/clear', (req, res) => {
  try {
    const { date, all } = (req.body ?? {}) as { date?: unknown; all?: unknown };
    if (all === true) {
      const { changes } = db.prepare('DELETE FROM audit_log').run();
      broadcast('audit.cleared', { scope: 'all' });
      return res.json({ ok: true, deleted: changes, scope: 'all' });
    }
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Provide a date in YYYY-MM-DD form, or all: true' });
    }
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const { changes } = db
      .prepare('DELETE FROM audit_log WHERE timestamp >= ? AND timestamp < ?')
      .run(`${date} 00:00:00`, `${next.toISOString().slice(0, 10)} 00:00:00`);
    broadcast('audit.cleared', { scope: date });
    res.json({ ok: true, deleted: changes, scope: date });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed to clear audit logs' });
  }
});

export default router;
