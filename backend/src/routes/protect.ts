import { Router } from 'express';
import db from '../db/index.js';
import { protectAgent, unprotectAgent, getProtectedAgents, syncAgentConnectors } from '../protect/rewriter.js';
import { detectAgents } from '../agent-det/detector.js';

const router = Router();

// P12: opt-in per-agent proxy re-wiring. These routes back up an agent's
// real MCP config, re-point its HTTP servers at the proxy, and can restore
// the original config byte-for-byte. See backend/ADR-proxy-injection.md.

router.get('/', (_req, res) => {
  res.json({ protected: getProtectedAgents() });
});

// Live detected-vs-protected counts (N7): Y = agents whose config exists on
// this machine right now; X = those actually rewired to the proxy.
router.get('/summary', (_req, res) => {
  try {
    const detected = detectAgents();
    const protectedTypes = new Set(getProtectedAgents().map((p) => p.type));
    res.json({
      detected: detected.length,
      protected: detected.filter((a) => protectedTypes.has(a.type)).length,
      agents: detected.map((a) => ({ type: a.type, name: a.name, protected: protectedTypes.has(a.type) })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Protection summary failed' });
  }
});

router.post('/:type', (req, res) => {
  try {
    const result = protectAgent(req.params.type);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Protect failed' });
  }
});

router.post('/:type/unprotect', (req, res) => {
  try {
    const result = unprotectAgent(req.params.type);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unprotect failed' });
  }
});

// Rescan an already-protected agent's config and pull late-added HTTP MCP
// entries into the proxy (connectors registered after protect otherwise keep
// talking to their real URL directly, completely bypassing the firewall).
router.post('/:type/sync', (req, res) => {
  try {
    const result = syncAgentConnectors(req.params.type);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Sync failed' });
  }
});

// Read-only detail of a protected agent (used by AgentDetail UI).
router.get('/:type', (req, res) => {
  const row = db
    .prepare('SELECT type, config_path as configPath, backup_path as backupPath, protected_at as protectedAt FROM protected_agents WHERE type = ?')
    .get(req.params.type);
  if (!row) return res.status(404).json({ error: 'Agent not protected' });
  res.json({ protected: row });
});

export default router;
