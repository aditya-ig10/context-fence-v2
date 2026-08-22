# Context Fence — progress.md

## v1.1.9-c — 2026-08-23

### Problem fixed
Multi-agent MCP config ingestion broke when switching agents that use
different config storage backends (file-based vs SQLite vs VSCode globalStorage).

### What changed
- NEW: backend/src/agent-det/adapters/ — AgentAdapter interface + registry
- NEW: adapters for OpenCode, ClaudeDesktop, ClaudeCode, Cline, Cursor, Windsurf, ProjectLocal
- REFACTORED: config-fetch.ts delegates to adapter registry (all exports preserved)
- REFACTORED: detector.ts AGENT_PATHS derived from registry watchPaths()
- REFACTORED: index.ts chokidar watchedConfigFiles derived from registry
- VERSION: 1.1.9-b → 1.1.9-c

### Adapters shipped
| Agent | Storage | Write support |
|-------|---------|---------------|
| OpenCode | JSONC file | ✅ |
| Claude Desktop | JSON file | ✅ |
| Claude Code | JSON file | ✅ |
| Cline | JSON (VSCode globalStorage or CLI path) | ❌ log-only |
| Cursor | JSON (globalStorage) | ❌ log-only |
| Windsurf | JSON file | ❌ log-only |
| Project-local .mcp.json | JSON file | ✅ |

### Verified
- [x] tsc: zero errors
- [x] node:test suite (mcp-fetch.test.ts + framer.test.ts): 29/29 pass, untouched
- [x] /api/health: 200 (`{"ok":true}` — packaged app serves on an OS-assigned port, not 3000)
- [x] /api/connectors/debug: all adapters listed (34 scanned paths; run with CF_DEV=1)
- [x] Cline path detected: `/Users/aditya/.cline/data/settings/cline_mcp_settings.json` (playwright entry parsed)
- [x] App opens and dashboard loads (proxy :3001 up with 4 spawned servers, ingress :3002 up)

### Known limitations
- Cline/Cursor/Windsurf write-side not implemented (logged, manual config required)
- SQLite-based storage not needed (all target agents use JSON files)
- Windows paths untested on this build

### Implementation notes (deviations from the original plan, all deliberate)
- CONFIG_PATHS = adapter registry specs **plus** legacy descriptors for Codex /
  GitHub Copilot / Continue / Aider — those four have no dedicated adapter yet,
  and both the pinned A1 path-list test and their Agents-page detection depend
  on them.
- fetchAllMcps() iterates every candidate path through its owning adapter
  (per-path results), not one read per adapter: opencode.jsonc AND opencode.json
  must merge with first-name-wins dedup, and install-gap tracking is keyed per
  path. `readAllConfigs()` (one read per adapter) exists for new consumers.
- injectMcpEntry() stayed the generic byte-preserving engine (shared by
  OpenCodeAdapter.write()) instead of delegating *to* it: tests pin clineFormat
  injection into arbitrary paths, which an OpenCode-only writer would break.
- The audit found Cline's live CLI config at
  `~/.cline/data/settings/cline_mcp_settings.json`; it is the PRIMARY candidate
  in ClineAdapter (ahead of VSCode/Insiders/Cursor globalStorage and the
  mcp_settings.json fallbacks), and the `~/.cline/data` directory entry stays
  last as a detection-only signal.

---

## v1.1.9-c patch 2 — 2026-08-23

### UI + Agent changes (same build, no version bump)

#### Agents page
- REMOVED: "Add Agent" button and AddAgentModal usage
- ADDED: "Refresh" button (top-right) — triggers POST /api/connectors/scan + refetch

#### New adapter: Gemini CLI (Antigravity)
- Paths: ~/.gemini/settings.json, ~/.config/gemini/settings.json,
  ~/.antigravity/mcp_settings.json, ~/.config/antigravity/mcp_settings.json,
  {cwd}/.gemini/settings.json
- Logo: https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png
  (generic terminal SVG fallback if it fails to load)
- Write support: ❌ log-only

#### Updated adapter table
| Agent | Storage | Write support |
|-------|---------|---------------|
| OpenCode | JSONC file | ✅ |
| Claude Desktop | JSON file | ✅ |
| Claude Code | JSON file | ✅ |
| Cline | JSON (CLI or VSCode globalStorage) | ❌ log-only |
| Cursor | JSON (globalStorage) | ❌ log-only |
| Windsurf | JSON file | ❌ log-only |
| Gemini CLI (Antigravity) | JSON file | ❌ log-only |
| Project-local .mcp.json | JSON file | ✅ |

#### Test MCP page
- CHANGED: unified flat MCP list — no per-agent grouping
- "Registered N" count now reflects total MCP server count
- NOTE: audit found TestMCP was ALREADY a flat, unfiltered view of GET /api/servers
  with a total-count badge — verified, no code change required there.

#### Bug fix: zero tool counts + calls today
- AUDIT RESULT: the SQL in routes/servers.ts was already correct — toolCount
  subqueries discovered_tools per server_name, callsToday queries audit_log with
  a start-of-day filter. Verified manually against both DBs.
- ROOT CAUSE of "0 tools": genuine data absence. The app uses its own DB at
  ~/Library/Application Support/Context Fence/data/context-fence.db (not
  backend/data/), where filesystem had never synced successfully — its spawn
  exited code=1 because /tmp/cf-fs-sandbox did not exist. Created the dir +
  ran Sync → filesystem now reports 14 tools, status connected.
- callsToday=0 is real (last audited calls are from Aug 4–5); query verified
  running, not null-cast-to-zero.
- Field alignment API ↔ ConnectorCard confirmed: toolCount / callsToday.

#### ConnectorDetail: per-agent config panel
- ADDED: "Configuration" section with two tabs
  - General: connection type, command/url, env keys masked with reveal toggle,
    last-synced timestamp (read-only)
  - Per-Agent: which agents declare this server, agent config vs registered
    diff view, green "In sync" / yellow "Out of sync" badges; entries rewired
    through the proxy ingress correctly report In sync (rewired)
- ADDED: GET /api/servers/:name/agent-configs backend endpoint
  (iterates AGENT_ADAPTERS with a 2s timeout per adapter read)

#### Verified
- [x] tsc: zero errors (backend + frontend)
- [x] /api/health: 200
- [x] context7 tools count: 2
- [x] filesystem tools count: 14 (after sandbox dir fix + Sync)
- [x] sequential-thinking tools count: 1 (known)
- [x] playwright tools count: 24 (regression check passed)
- [x] Gemini CLI adapter: paths registered in packaged build (5 paths, 39 total);
      parse verified via virtual-fs test (mcpServers + command:string+args +
      disabled flag all handled). No gemini config exists on this machine to detect.
- [x] Per-Agent tab loads without error — live response for `playwright`:
      OpenCode IN SYNC (rewired), Cline IN SYNC (rewired), Project MCP IN SYNC

---

## v1.1.9-c patch 3 — 2026-08-23

### Fix: agy (Antigravity CLI) not detected

#### Root cause
The AntigravityAdapter's candidate paths were based on documented Gemini CLI
locations (~/.gemini/settings.json etc.) — none of which exist for the actual
`agy` binary installed at ~/.local/bin/agy. Strings extracted from the Go
binary showed its real config root: `~/.gemini/config/`, with MCP servers in
`config/mcp_config.json` and plugin servers in `config/plugins/<name>/mcp_config.json`.

#### What changed
- ADDED primary path: `~/.gemini/config/mcp_config.json` (first in scan order)
- ADDED startup glob: `~/.gemini/config/plugins/*/mcp_config.json`
- Existing fallback paths kept after the new primary
- Files: adapters/core.ts (path specs), adapters/antigravity.ts (plugin glob)

#### Verified
- [x] tsc: zero errors; node:test 29/29 pass
- [x] Real file parses: ~/.gemini/config/mcp_config.json → StitchMCP entry
- [x] Rebuilt DMG + reinstalled; app relaunched clean
- [x] /api/detect: "Gemini CLI (Antigravity)" listed with type `gemini`, mcp: StitchMCP
- [x] /api/servers: StitchMCP registered, spawned, **connected, 15 tools**
- [x] All other agents unaffected (OpenCode, Claude Code, Codex, Cline still detected)

---

## v1.1.9-c patch 4 — 2026-08-23

### Gemini CLI (Antigravity): show available stats + server-side* marker

#### Context
agy is server-side-metered: inference runs on Google's models and token/cost
accounting never touches the local disk. The only local data is
conversation_summaries.db (sessions, step counts, timestamps), the selected
model label in antigravity-cli/settings.json, and config files on disk.

#### What changed
- ADDED: parseGeminiStats in detector.ts (registered for type `gemini`)
  - sessions / conversations from conversation_summaries.db row count
  - steps = SUM(step_count) (4,130 across 28 conversations on this machine)
  - daily activity chart fed by per-day SUM(step_count) — labelled as steps,
    not tokens
  - model label from ~/.gemini/antigravity-cli/settings.json
    ("Gemini 3.1 Pro (High)")
  - install date: MIN(last_user_input_time), zero-dates discarded, falls back
    to ~/.gemini directory birthtime; lastActive = MAX(last_modified_time)
  - dataPath set to ~/.gemini for the detail view
- ADDED: `steps` field to AgentStats (backend interface + both frontend copies)
- UI (Agents page): Steps chip added; dedicated always-visible "Server-side*"
  badge on gemini/antigravity cards (tooltip explains the asterisk)
- UI (AgentDetail): Steps stat row; italic footnote under the stats grid:
  "* Tokens & cost are metered server-side by Google — only sessions, steps
  and activity timestamps are stored on this machine."; activity chart
  relabelled "Activity* (steps)" with legend "Steps*" instead of Tokens

#### Verified
- [x] tsc: zero errors (backend + frontend)
- [x] Live API GET /api/detect/gemini → sessions: 28, conversations: 28,
      steps: 4130, models: ["Gemini 3.1 Pro (High)"], install: 2026-03-09,
      lastActive: 2026-05-06, dailyUsage days: 11, mcp: StitchMCP
- [x] Rebuilt DMG, reinstalled, app relaunched clean (/api/health 200)
