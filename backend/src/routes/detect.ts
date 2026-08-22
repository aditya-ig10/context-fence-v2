import { Router } from 'express';
import { detectAgents, hydrateAllAgentStats, getMcpServersFromConfigs, detectFromPath, getAgentByType, detectMcpConnectors } from '../agent-det/detector.js';
import db from '../db/index.js';

const router = Router();

// N1: connector-level scan — every MCP server entry declared in each detected
// agent's config, as "detected, not yet imported" candidates. Env/header
// VALUES are never returned, only key names + presence flags; import performs
// the write server-side (POST /api/servers/:name/import).
router.get('/mcp-configs', (_req, res) => {
  try {
    res.json({ agents: detectMcpConnectors(), scannedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Connector detection failed' });
  }
});

router.post('/scan', (_req, res) => {
  try {
    const agents = detectAgents();
    const mcpServers = getMcpServersFromConfigs();
    res.json({ ok: true, agents, mcp_servers: mcpServers, scannedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Detection failed' });
  }
});

router.get('/', (_req, res) => {
  try {
    const agents = detectAgents();
    // Hydrate real per-agent stats (sessions/messages/tokens + lastActive) so
    // the Agents list can rank cards by most-recently-used and show real
    // numbers. Boot scan stays light, but the list view wants the full picture.
    hydrateAllAgentStats(agents);
    res.json({ agents, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch detected agents' });
  }
});

router.get('/:type', (req, res) => {
  try {
    const agent = getAgentByType(req.params.type);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch agent' });
  }
});

router.post('/manual', (req, res) => {
  try {
    const { path } = req.body as { path?: string };
    if (!path) return res.status(400).json({ error: 'path required' });

    const agent = detectFromPath(path);
    if (!agent) return res.status(404).json({ error: 'No known agent found at that path' });

    db.prepare(`
      INSERT INTO detected_agents (id, name, type, pid, command, config_path, first_seen, last_seen, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen = excluded.last_seen,
        status = excluded.status
    `).run(
      agent.id, agent.name, agent.type,
      null, null, agent.configPath,
      agent.firstSeen, agent.lastSeen, agent.status,
    );

    res.json({ ok: true, agent });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to add agent' });
  }
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM detected_agents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
