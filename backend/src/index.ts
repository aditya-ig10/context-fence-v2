import express from 'express';
import cors from 'cors';
import http from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import chokidar from 'chokidar';
import { loadPolicy } from './policy/engine.js';
import { startProxy, startHttpIngress, spawnRegisteredServer, discoverTools } from './mcp/proxy.js';
import { attachRealtimeHub, broadcast } from './realtime/hub.js';
import { autoDiscoverConnectors, pathsMatch } from './agent-det/detector.js';
import { getAllWatchPaths } from './agent-det/adapters/registry.js';
import { adapterSelfWritten } from './agent-det/adapters/base.js';
import { syncAgentConnectors, healSelfLoopRows, selfWrittenConfigs } from './protect/rewriter.js';
import {
  CONFIG_PATHS,
  fetchAllMcps,
  fetchMcpsFromConfig,
  injectMcpEntry,
  pickOpenCodeConfigPath,
} from './agent-det/config-fetch.js';
import { deepReason } from './agent-det/reasoner.js';
import db from './db/index.js';

// Routes
import statsRouter from './routes/stats.js';
import agentsRouter from './routes/agents.js';
import policiesRouter from './routes/policies.js';
import logsRouter from './routes/logs.js';
import settingsRouter, { runRetentionCleanup } from './routes/settings.js';
import testMcpRouter from './routes/test-mcp.js';
import detectRouter from './routes/detect.js';
import firewallRouter from './routes/firewall.js';
import serversRouter from './routes/servers.js';
import protectRouter from './routes/protect.js';
import { errorHandler } from './middleware/errorHandler.js';
import { rateLimiter } from './middleware/rateLimiter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

// Load policy from cwd or data dir
const policyDir = process.env.CF_POLICY_DIR || process.cwd();
loadPolicy(policyDir);

const app = express();

app.use(cors({ origin: '*' }))
app.use(rateLimiter);
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api/stats', statsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/policies', policiesRouter);
app.use('/api/logs', logsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/test-mcp', testMcpRouter);
app.use('/api/detect', detectRouter);
app.use('/api/firewall', firewallRouter);
app.use('/api/servers', serversRouter);
app.use('/api/protect', protectRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Manual trigger of the full discovery sequence ("make any MCP I add via npm
// or any other source set itself up in Context Fence"): rescan agent configs,
// heal self-loops, rewire protected agents, spawn stdio children and
// tool-sync every touched connector — the exact pass the 30s interval and
// config watcher run, but on demand. Used by scripts/trigger-mcp-fetch.mjs
// and the TestMCP "Refresh" button (B3: full disk read, no cache).
app.post('/api/connectors/scan', (_req, res) => {
  try {
    const touched = discoverConnectorsOnce({ spawnStdio: true });
    const total = fetchAllMcps();
    res.json({
      ok: true,
      scanned: touched,
      scannedAt: new Date().toISOString(),
      totalMcps: total.entries.length,
      configFiles: total.results.filter((r) => r.exists).length,
      configs: total.results.map((r) => ({ path: r.path, name: r.name, type: r.type, exists: r.exists, mcps: r.entries.length, parseError: r.parseError ?? null })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Discovery scan failed' });
  }
});

// Install-gap check (A4): surface the "install reported success but no new
// MCP appeared" case. Tracked per config file — when a file's mtime changes
// but its MCP count did not increase, the user is told to check their config
// path instead of staring at an empty list. Throttled per path: editors save
// config files constantly (a settings tweak, a Claude Desktop session write)
// and every save without a new MCP would otherwise toast the user all day.
const lastConfigState = new Map<string, { mtimeMs: number; count: number }>();
const lastGapBroadcastAt = new Map<string, number>();
const GAP_THROTTLE_MS = 60_000;

function detectInstallGap(): void {
  const now = Date.now();
  for (const cfg of CONFIG_PATHS) {
    const res = fetchMcpsFromConfig(cfg);
    if (!res.exists) {
      lastConfigState.delete(cfg.path);
      continue;
    }
    const prev = lastConfigState.get(cfg.path);
    const mtimeMs = res.mtimeMs ?? 0;
    const changed = !prev || prev.mtimeMs !== mtimeMs;
    lastConfigState.set(cfg.path, { mtimeMs, count: res.entries.length });
    if (changed && prev && res.entries.length <= prev.count) {
      // Our own protect/sync/unprotect/unbind rewrites change mtime without
      // adding MCP entries — skipping them prevents the misleading
      // "install reported success but no new entry detected" toast right
      // after the user clicks Unprotect (or Protect).
      if (selfWrittenConfigs.get(cfg.path) === mtimeMs || adapterSelfWritten.get(cfg.path) === mtimeMs) continue;
      const lastAt = lastGapBroadcastAt.get(cfg.path) ?? 0;
      if (now - lastAt < GAP_THROTTLE_MS) continue;
      lastGapBroadcastAt.set(cfg.path, now);
      const message = 'MCP install reported success but no new entry detected in config. Check your config path.';
      console.warn(`[discovery] install-gap: ${cfg.path} changed but MCP count did not increase (${prev.count} -> ${res.entries.length})`);
      broadcast('discovery.install-gap', { path: cfg.path, count: res.entries.length, message });
    }
  }
}

// Debug panel data (D2, dev-only): every scanned path with its parsed state,
// raw content, per-file MCP counts, last refresh timestamp and any parse
// errors — the surface that catches silent config-read failures.
app.get('/api/connectors/debug', (_req, res) => {
  if (IS_PROD && process.env.CF_DEV !== '1') return res.status(404).json({ error: 'not found' });
  try {
    const total = fetchAllMcps();
    res.json({
      lastScanAt: lastDiscoveryScanAt ? new Date(lastDiscoveryScanAt).toISOString() : null,
      totalMcps: total.entries.length,
      paths: total.results.map((r) => ({
        path: r.path,
        name: r.name,
        type: r.type,
        exists: r.exists,
        format: r.format,
        parseError: r.parseError ?? null,
        mcps: r.entries.map((e) => e.name),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Debug scan failed' });
  }
});

// sequential-thinking presence (C1): the fetch pipeline is the single
// source of truth — an entry declared anywhere (opencode.jsonc/json,
// project-local, or any other agent's config) counts.
app.get('/api/connectors/reasoning', (_req, res) => {
  const total = fetchAllMcps();
  const entry = total.entries.find((e) => e.name === 'sequential-thinking') ?? null;
  res.json({ present: !!entry, source: entry?.source ?? null, command: entry?.command ?? null });
});

// User-confirmed injection (C1): adds the sequential-thinking entry to the
// opencode config via a byte-preserving splice — comments and formatting in
// the target file are untouched, only the new entry is written.
app.post('/api/connectors/inject', (req, res) => {
  try {
    const { name, type, command } = req.body as { name?: string; type?: string; command?: string[] };
    const entryName = name && name.trim() ? name.trim() : 'sequential-thinking';
    const entryCommand = Array.isArray(command) && command.length > 0
      ? command.map(String)
      : ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking'];
    const target = pickOpenCodeConfigPath();
    const result = injectMcpEntry(target, { name: entryName, type: typeof type === 'string' && type.trim() ? type.trim() : 'local', command: entryCommand });
    if (!result.ok) return res.status(422).json(result);
    // Re-run discovery right away so the injected MCP registers + spawns.
    const touched = discoverConnectorsOnce({ spawnStdio: true });
    res.json({ ...result, touched });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Injection failed' });
  }
});

// C2: route a multi-step reasoning task through the sequential-thinking MCP
// when it is connected; falls back to local decomposition otherwise.
app.post('/api/connectors/reasoning/eval', async (req, res) => {
  try {
    const { task } = req.body as { task?: string };
    if (!task || !task.trim()) return res.status(400).json({ error: 'task required' });
    const result = await deepReason(task.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Reasoning failed' });
  }
});

// Serve built frontend in production (Electron loadFile mode)
if (IS_PROD) {
  const distPath = join(__dirname, '..', '..', 'frontend', 'dist');
  if (existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(join(distPath, 'index.html'));
    });
  }
}

// Auto-registration of agent-declared MCP connectors (the "Test MCP page
// should list what the agents configured" behavior): scan detected agent
// configs into mcp_servers at boot (before startProxy so new stdio servers
// get spawned like any registered row) and on a 30s interval. The loop is
// fully automatic — NO manual protect/unprotect/sync needed when a user adds
// a new MCP to a protected agent's config:
//   1. autoDiscoverConnectors creates/updates the mcp_servers row from the
//      config entry (stdio command or HTTP/remote URL).
//   2. healSelfLoopRows repairs any self-loop rows (http row pointing at our
//      own ingress) from the agent backup, so the old "fetch failed" bug can
//      no longer occur by accident.
//   3. syncAgentConnectors(type) for every PROTECTED agent rewires late-added
//      entries to the proxy and re-registers their stdio command (the step
//      users previously had to trigger by hand).
//   4. Newly created/healed/rewired servers are spawned (if stdio) and have
//      their tools synced + a connector.status broadcast, so the TestMCP page
//      picks them up instantly without a manual action.
//
// A chokidar watcher below re-runs this same pass (debounced) whenever an
// agent config file changes — a newly added MCP appears in the UI within a
// second or two instead of waiting for the next 30s tick.
let discoveryInFlight = false;
let lastDiscoveryScanAt: number | null = null;
function discoverConnectorsOnce(options: { spawnStdio: boolean }): string[] {
  // The 30s interval and the config watcher can fire concurrently; the scan
  // (rewriter + spawn + tool-sync) must not overlap.
  if (discoveryInFlight) return [];
  discoveryInFlight = true;
  try {
    const { created } = autoDiscoverConnectors();
    const healed = healSelfLoopRows();

    // Auto-wire: pull late-added entries of protected agents into the proxy.
    const rewired: string[] = [];
    const protectedTypes = (db.prepare('SELECT type FROM protected_agents').all() as { type: string }[]).map((r) => r.type);
    for (const type of protectedTypes) {
      try {
        const result = syncAgentConnectors(type);
        rewired.push(...result.rewrittenServers.map((s) => s.name));
      } catch (err) {
        console.warn(`[discovery] auto-wire skipped for protected agent "${type}":`, err instanceof Error ? err.message : err);
      }
    }

    const touched = new Set([...created, ...healed, ...rewired]);
    for (const name of touched) {
      if (options.spawnStdio) {
        const row = db.prepare('SELECT type FROM mcp_servers WHERE name = ?').get(name) as { type: string } | undefined;
        if (row?.type === 'stdio') {
          const r = spawnRegisteredServer(name);
          if (r.ok) db.prepare('UPDATE mcp_servers SET connected = 1 WHERE name = ?').run(name);
        }
      }
      // Auto tool-sync so the card shows real tools (not 0 / stale) without a
      // manual Sync click. Best-effort; failures leave connected=0.
      void autoSyncTools(name);
      broadcast('connector.status', { name, discovered: true });
    }
    if (touched.size > 0) {
      console.log(`[discovery] Auto-registered/updated ${[...touched].join(', ')} from agent configs`);
    }
    // Install-gap: a config changed but declared no new MCP — surface a
    // warning instead of silently showing nothing.
    detectInstallGap();
    return [...touched];
  } catch (err) {
    console.error('[discovery] Auto-registration scan failed:', err);
    return [];
  } finally {
    lastDiscoveryScanAt = Date.now();
    discoveryInFlight = false;
  }
}

const autoSyncing = new Set<string>();

/** Discover + persist tools for one connector without blocking the scan
 *  loop. Mirrors POST /api/servers/:name/sync-tools but is never a manual
 *  action. Capped so a single misbehaving server cannot balloon the table. */
async function autoSyncTools(name: string): Promise<void> {
  if (autoSyncing.has(name)) return;
  autoSyncing.add(name);
  try {
    const MAX_TOOLS = 500;
    const result = await discoverTools(name);
    if (result.ok) {
      const upsert = db.prepare(`
        INSERT INTO discovered_tools (server_name, tool_name, tool_schema, last_synced_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(server_name, tool_name) DO UPDATE SET
          tool_schema = excluded.tool_schema,
          last_synced_at = excluded.last_synced_at
      `);
      db.prepare('DELETE FROM discovered_tools WHERE server_name = ?').run(name);
      for (const t of result.tools.slice(0, MAX_TOOLS)) {
        upsert.run(name, t.name, JSON.stringify({ description: t.description, inputSchema: t.inputSchema }));
      }
      db.prepare("UPDATE mcp_servers SET connected = 1, last_check = datetime('now') WHERE name = ?").run(name);
    } else {
      db.prepare("UPDATE mcp_servers SET connected = 0, last_check = datetime('now') WHERE name = ?").run(name);
    }
    broadcast('connector.status', { name, connected: result.ok });
  } catch (err) {
    console.warn(`[discovery] autoSyncTools(${name}):`, err instanceof Error ? err.message : err);
  } finally {
    autoSyncing.delete(name);
  }
}

discoverConnectorsOnce({ spawnStdio: false });
setInterval(() => discoverConnectorsOnce({ spawnStdio: true }), 30_000);

// Watch every EXISTING agent config file and re-run the discovery scan on
// change. The scan itself is debounced so a burst of writes (e.g. an editor
// rename-save) maps to a single pass. Only events on a known config file
// trigger a scan.
//
// macOS Sequoia+ prompts "…would like to access data from other apps" for
// fsevents watchers on OTHER apps' data dirs (~/Library/Application Support/
// <agent>, ~/.claude, …) — one popup per directory on every launch. To keep
// startup prompt-free we watch config FILES only (their own reads are the
// product's core function and stay), and NEVER add parent-directory watches
// under the user's Library. Configs that don't exist yet (or live under
// ~/Library) are picked up by the 30s interval scan instead of the watcher.
// Watch list derived from the adapter registry (single source of truth shared
// with CONFIG_PATHS and AGENT_PATHS) — every existing candidate config file,
// including the project-local .mcp.json.
const watchedConfigFiles = new Set<string>(
  getAllWatchPaths().filter((p) => existsSync(p)),
);
let configWatchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleConfigScan(): void {
  if (configWatchTimer) return;
  configWatchTimer = setTimeout(() => {
    configWatchTimer = null;
    discoverConnectorsOnce({ spawnStdio: true });
  }, 500);
}

// Windows: chokidar emits forward-slash paths while CONFIG_PATHS hold
// backslash join() paths, and NTFS is case-insensitive — a strict Set lookup
// never matches and config changes are only caught by the 30s interval.
// pathsMatch is the platform-aware comparison (case-folded on Windows).
const isWatchedConfigPath = (p: string): boolean =>
  [...watchedConfigFiles].some((w) => pathsMatch(p, w));

try {
  chokidar
    .watch([...watchedConfigFiles], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })
    .on('error', (err) => console.warn('[discovery] config watcher error:', err instanceof Error ? err.message : err))
    .on('all', (_event, path) => {
      if (isWatchedConfigPath(path)) scheduleConfigScan();
    });
} catch (err) {
  console.warn('[discovery] Config watcher failed to start:', err instanceof Error ? err.message : err);
}

// Start MCP proxy on port 3001
startProxy().catch((err) => {
  console.error('[proxy] Failed to start MCP proxy:', err);
});

// Start HTTP MCP ingress on port 3002 (real agent traffic, P12)
startHttpIngress().catch((err) => {
  console.error('[proxy] Failed to start HTTP MCP ingress:', err);
});

// Data retention job: enforce the audit_log retention window from settings
// every 60s (also triggerable on demand via POST /api/settings/retention/run).
setInterval(() => {
  try {
    const deleted = runRetentionCleanup();
    if (deleted > 0) console.log(`[retention] Cleanup removed ${deleted} audit_log rows`);
  } catch (err) {
    console.error('[retention] Cleanup job failed:', err);
  }
}, 60_000);

app.use(errorHandler);

const server = http.createServer(app);
attachRealtimeHub(server);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[backend] Context Fence backend running on http://localhost:${PORT}`);
});