import { Router } from 'express';
import db from '../db/index.js';
import { setLogOnly, isLogOnly, isEnvBlockEnabled } from '../policy/engine.js';
import { PROXY_PORT, testDenyWebhook } from '../mcp/proxy.js';
import { getMergedPolicies } from './policies.js';

const router = Router();

const BACKEND_PORT = parseInt(process.env.PORT || '3000', 10);

export function getRetentionDays(): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'audit_retention_days'")
    .get() as { value: string } | undefined;
  if (!row) return 0; // 0 = keep forever (default)
  const days = parseInt(row.value, 10);
  return isNaN(days) || days < 0 ? 0 : days;
}

// Delete audit_log rows older than the configured retention window. Returns
// the number of rows removed. 0 (or "forever") deletes nothing.
export function runRetentionCleanup(): number {
  const days = getRetentionDays();
  if (days === 0) return 0;
  const result = db
    .prepare("DELETE FROM audit_log WHERE timestamp < datetime('now', ?)")
    .run(`-${days} days`);
  return result.changes;
}

router.get('/', (_req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) settings[row.key] = row.value;
    res.json({
      settings,
      // Read-only proxy configuration (changing these requires a restart).
      proxy: {
        proxyPort: PROXY_PORT,
        backendPort: BACKEND_PORT,
        note: 'Changing ports requires a restart',
      },
      retention: { days: getRetentionDays() },
      logOnly: isLogOnly(),
      envBlock: isEnvBlockEnabled(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch settings' });
  }
});

router.put('/:key', (req, res) => {
  try {
    const { value } = req.body as { value?: string };
    if (value === undefined) return res.status(400).json({ error: 'value required' });

    // log_only is special: it also writes through to the loaded policy YAML
    // so the toggle survives a restart, not just the settings table.
    if (req.params.key === 'log_only') {
      setLogOnly(value !== 'false');
      return res.json({ ok: true });
    }
    if (req.params.key === 'audit_retention_days') {
      const days = parseInt(value, 10);
      if (isNaN(days) || days < 0) return res.status(400).json({ error: 'retention days must be >= 0' });
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(req.params.key, String(days));
      return res.json({ ok: true });
    }

    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(req.params.key, value);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update setting' });
  }
});

// Run the retention cleanup now (also runs automatically every 60s).
router.post('/retention/run', (_req, res) => {
  try {
    const deleted = runRetentionCleanup();
    res.json({ ok: true, deleted, retentionDays: getRetentionDays() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to run retention cleanup' });
  }
});

// Send a synthetic deny payload to the configured webhook (Settings UI test).
router.post('/webhook/test', async (_req, res) => {
  try {
    const result = await testDenyWebhook();
    res.json({ ok: result.sent, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to test webhook' });
  }
});

// Full data export: audit log + policies (merged) + settings + agents in one
// JSON bundle for backup.
router.get('/export', (_req, res) => {
  try {
    const audit = db.prepare('SELECT * FROM audit_log ORDER BY timestamp').all();
    const agents = db.prepare('SELECT * FROM agents ORDER BY created_at').all();
    const settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'mcp-firewall',
      audit_log: audit,
      policies: getMergedPolicies(),
      settings,
      agents,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="mcp-firewall-backup.json"');
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to export data' });
  }
});

export default router;
