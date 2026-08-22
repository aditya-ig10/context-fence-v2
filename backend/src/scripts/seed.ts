import db from '../db/index.js';
const agents = ['claude-code', 'opencode', 'cursor', 'codex', 'copilot'];
for (const name of agents) {
  db.prepare(
    'INSERT OR IGNORE INTO detected_agents (id, name, type, pid, command, config_path, status) VALUES (?, ?, ?, NULL, NULL, NULL, \'active\')',
  ).run(`seed-${name}`, name, name);
}
console.log('Seeded', agents.length, 'agents');
