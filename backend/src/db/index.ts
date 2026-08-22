import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Store DB in user data dir so it persists across app updates
const dataDir = process.env.CF_DATA_DIR || join(__dirname, '..', '..', 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const DB_PATH = join(dataDir, 'context-fence.db');

export const db = new Database(DB_PATH);

// Enable WAL for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id          TEXT PRIMARY KEY,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    agent       TEXT NOT NULL,
    tool        TEXT NOT NULL,
    method      TEXT NOT NULL,
    params      TEXT,
    decision    TEXT NOT NULL CHECK(decision IN ('allow','deny','log')),
    reason      TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    session_id  TEXT,
    raw_request TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_log(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_log(decision);
  CREATE INDEX IF NOT EXISTS idx_audit_agent    ON audit_log(agent);

  CREATE TABLE IF NOT EXISTS agents (
    name       TEXT PRIMARY KEY,
    api_key    TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen  TEXT,
    call_count INTEGER NOT NULL DEFAULT 0,
    blocked_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS detected_agents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'unknown',
    pid         INTEGER,
    command     TEXT,
    config_path TEXT,
    first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive'))
  );

  CREATE TABLE IF NOT EXISTS mcp_servers (
    name        TEXT PRIMARY KEY,
    type        TEXT NOT NULL DEFAULT 'http',
    url         TEXT,
    command     TEXT,
    args        TEXT,
    env         TEXT,
    headers     TEXT,
    connected   INTEGER NOT NULL DEFAULT 0,
    last_check  TEXT
  );

  -- Opt-in per-agent protection (P12): one row per protected agent, created
  -- when the user clicks "Protect this agent". Holds everything needed to
  -- restore the agent's real config byte-for-byte from the backup file.
  CREATE TABLE IF NOT EXISTS protected_agents (
    type            TEXT PRIMARY KEY,
    config_path     TEXT NOT NULL,
    backup_path     TEXT NOT NULL,
    original_hash   TEXT NOT NULL,
    original_headers TEXT,
    protected_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS custom_policies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    action      TEXT NOT NULL CHECK(action IN ('allow','deny','log')),
    reason      TEXT NOT NULL DEFAULT '',
    methods     TEXT DEFAULT '',
    tools       TEXT DEFAULT '',
    param_contains TEXT DEFAULT '',
    path_patterns  TEXT DEFAULT '',
    domain_patterns TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stats_history (
    date    TEXT PRIMARY KEY,
    calls   INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0
  );

  -- Connector management (TestMCP redesign): which agents a connector is
  -- bound to. One row per (agent, server) binding; enabled=0 is a soft
  -- unbind that keeps the config rewrite record but suspends the flow.
  CREATE TABLE IF NOT EXISTS agent_connectors (
    agent_type      TEXT NOT NULL,
    server_name     TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    policy_overrides TEXT,
    bound_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_type, server_name),
    FOREIGN KEY (server_name) REFERENCES mcp_servers(name) ON DELETE CASCADE
  );

  -- Live tool inventory per connector
  CREATE TABLE IF NOT EXISTS discovered_tools (
    server_name     TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    tool_schema     TEXT NOT NULL DEFAULT '{}',
    last_synced_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_name, tool_name),
    FOREIGN KEY (server_name) REFERENCES mcp_servers(name) ON DELETE CASCADE
  );

  -- Distributed Fleet Nodes
  CREATE TABLE IF NOT EXISTS fleet_nodes (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL,
    hostname        TEXT NOT NULL,
    os              TEXT NOT NULL,
    version         TEXT NOT NULL,
    status          TEXT NOT NULL CHECK(status IN ('online','offline','degraded')),
    cpu_pct         REAL NOT NULL DEFAULT 0.0,
    mem_pct         REAL NOT NULL DEFAULT 0.0,
    latency_ms      REAL NOT NULL DEFAULT 0.0,
    policy_status   TEXT NOT NULL CHECK(policy_status IN ('ok','drift','unknown')),
    last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
    sync_trigger    TEXT,
    events_24h      INTEGER NOT NULL DEFAULT 0,
    blocked_24h     INTEGER NOT NULL DEFAULT 0
  );

  -- 5-minute Fleet Time-Series Snapshots
  CREATE TABLE IF NOT EXISTS fleet_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
    time_ms         INTEGER NOT NULL,
    total_nodes     INTEGER NOT NULL DEFAULT 1,
    online_nodes    INTEGER NOT NULL DEFAULT 1,
    degraded_nodes  INTEGER NOT NULL DEFAULT 0,
    offline_nodes   INTEGER NOT NULL DEFAULT 0,
    avg_cpu         REAL NOT NULL DEFAULT 0.0,
    avg_mem         REAL NOT NULL DEFAULT 0.0,
    avg_latency     REAL NOT NULL DEFAULT 0.0,
    compliance_score INTEGER NOT NULL DEFAULT 100
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_snap_time ON fleet_snapshots(time_ms DESC);

  -- Enterprise SIEM Configurations & Remote Endpoints
  CREATE TABLE IF NOT EXISTS siem_destinations (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL CHECK(type IN ('splunk','datadog','elk','syslog')),
    name            TEXT NOT NULL,
    host            TEXT NOT NULL,
    port            INTEGER NOT NULL,
    protocol        TEXT NOT NULL DEFAULT 'HTTPS',
    api_key_ref     TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_ping       TEXT NOT NULL DEFAULT (datetime('now')),
    last_ping_status TEXT NOT NULL DEFAULT 'active',
    events_forwarded INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- SIEM Dispatched Event Audit Stream
  CREATE TABLE IF NOT EXISTS siem_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
    severity        TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    agent_id        TEXT,
    destination_id  TEXT NOT NULL,
    forwarded       INTEGER NOT NULL DEFAULT 1,
    error_msg       TEXT,
    payload_json    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_siem_events_ts ON siem_events(timestamp DESC);
`);

// Migrations for pre-existing databases: the mcp_servers.headers column
// (P12 auth injection) was added after the table shipped, so CREATE TABLE
// IF NOT EXISTS won't add it to an older DB.
const mcpColumns = db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[];
if (!mcpColumns.some((c) => c.name === 'headers')) {
  db.exec('ALTER TABLE mcp_servers ADD COLUMN headers TEXT');
}
// Connector-management columns added with the TestMCP redesign: auth_type
// drives the per-connector auth config (none/apikey/bearer/oauth2 — the
// credentials themselves still live in the existing headers column).
if (!mcpColumns.some((c) => c.name === 'auth_type')) {
  db.exec("ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none'");
}
if (!mcpColumns.some((c) => c.name === 'created_at')) {
  db.exec("ALTER TABLE mcp_servers ADD COLUMN created_at TEXT");
}
// Binding provenance: the discovery scan auto-creates rows for every
// (agent, server) pair declared in an agent config ('discovered'); manual
// binds/unbinds from the UI write 'manual'. The scan only creates/re-asserts
// discovered rows — never manual ones — so a user's explicit unbind survives.
const acColumns = db.prepare("PRAGMA table_info(agent_connectors)").all() as { name: string }[];
if (!acColumns.some((c) => c.name === 'origin')) {
  db.exec("ALTER TABLE agent_connectors ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
}
// Removal persistence (TestMCP redesign): when a user deletes a connector we
// soft-delete it (removed=1) so the periodic config re-scan does NOT resurrect
// it the next time it reads the agent's config file. A removed row is filtered
// out of every read and NOT re-INSERTed by the discovery scan.
if (!mcpColumns.some((c) => c.name === 'removed')) {
  db.exec("ALTER TABLE mcp_servers ADD COLUMN removed INTEGER NOT NULL DEFAULT 0");
}
const policyColumns = db.prepare("PRAGMA table_info(custom_policies)").all() as { name: string }[];
if (!policyColumns.some((c) => c.name === 'servers')) {
  db.exec('ALTER TABLE custom_policies ADD COLUMN servers TEXT');
}
// audit_log gained a server column so per-connector call counts are real
// (derived from the audit trail, not fabricated).
const auditColumns = db.prepare("PRAGMA table_info(audit_log)").all() as { name: string }[];
if (!auditColumns.some((c) => c.name === 'server')) {
  db.exec('ALTER TABLE audit_log ADD COLUMN server TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_log(server)');

export default db;