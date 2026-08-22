import { Router } from 'express';
import db from '../db/index.js';
import { broadcast } from '../realtime/hub.js';

const router = Router();

router.get('/', (_req, res) => {
  try {
    const agents = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch agents' });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, api_key } = req.body as { name?: string; api_key?: string };
    if (!name || !api_key) return res.status(400).json({ error: 'name and api_key required' });

    const stmt = db.prepare('INSERT INTO agents (name, api_key) VALUES (?, ?)');
    stmt.run(name, api_key);
    broadcast('agent.updated', { name });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to register agent' });
  }
});

router.delete('/:name', (req, res) => {
  try {
    db.prepare('DELETE FROM agents WHERE name = ?').run(req.params.name);
    broadcast('agent.updated', { name: req.params.name });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete agent' });
  }
});

export default router;
