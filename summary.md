# Context Fence (mcp-firewall) — Project Summary

## What It Is

A **local-first security control plane for AI coding agents** (Claude Code, OpenCode, Cursor, Copilot, etc.). It sits between agents and their MCP servers, intercepting every tool call, evaluating it against a policy engine, and blocking, logging, or allowing it. A React dashboard provides monitoring, policy editing, audit logs, agent detection, and agent protection.

Also known as "MCP Firewall" / "Context Fence".

---

## Top-Level Structure

```
mcp-firewall/
├── .env.example              # Backend env var documentation
├── .gitignore                # node_modules, dist, .env, clean/, backend/data/, etc.
├── .prettierrc               # Prettier formatting config
├── firestore.rules           # Firebase Firestore security rules (users/{uid} owner-only)
├── README.md                 # Project documentation
├── summary.md                # This file
├── backend/                  # Express API (:3000) + MCP proxy (:3001/:3002) + policy engine
├── frontend/                 # Vite + React 19 dashboard (:5173)
└── clean/                    # Empty scratch dir (gitignored, only .DS_Store)
```

> Note: An `electron/` desktop-app directory existed in git history but was deleted from the working tree. `.gitignore` still references `electron/release/` and `electron/staging/`.

---

## Backend (`backend/`)

**Stack:** Node.js (ESM, TypeScript), Express 4, better-sqlite3, ws, tsx for dev.

**Scripts:**
- `npm run dev` — `tsx watch src/index.ts`
- `npm run build` — `tsc` (outputs `dist/`)
- `npm start` — `node dist/index.js`

**Dependencies:** `better-sqlite3`, `chokidar`, `cors`, `express`, `js-yaml`, `jsonc-parser`, `node-fetch`, `uuid`, `ws`.

### Entry Point — `src/index.ts`
- Express app on port `3000` (`PORT`), bound to `127.0.0.1`.
- Middleware: `cors({ origin: '*' })`, `express.json({ limit: '10mb' })`.
- Loads policy from `CF_POLICY_DIR` (or cwd) via `loadPolicy()`.
- Mounts routers: `/api/stats`, `/api/agents`, `/api/policies`, `/api/logs`, `/api/settings`, `/api/test-mcp`, `/api/detect`, `/api/firewall`, `/api/servers`, `/api/protect`.
- `GET /api/health` → `{ ok: true, ts }`.
- Starts MCP proxy on `:3001` and HTTP MCP ingress on `:3002`.
- Runs 60s audit-log retention cleanup job.
- Production mode (`NODE_ENV=production`): serves `frontend/dist` statically with SPA fallback.

### Core Module — `src/mcp/proxy.ts` (the heart of the firewall)
- **`PROXY_PORT` (3001)** — raw TCP JSON-RPC ingress for stdio-style agents; **`PROXY_HTTP_PORT` (3002)** — HTTP MCP ingress for streamable-HTTP clients (e.g. OpenCode `type: remote`).
- **`decideAndForward()`** — per-request pipeline: firewall-enabled check → `evaluateRequest()` → deny = synthesized JSON-RPC error + audit + webhook; allow/log = forward to child server + audit with actual outcome. `id: null` notifications are handled without a response.
- **`spawnMcpServer()`** — spawns registered stdio servers (`mcp_servers` table) as detached child processes, performs the `initialize` handshake (protocol `2025-03-26`), buffers requests until ready (8s timeout), pipes stdout through a `JsonRpcFramer`.
- **`handleSocket()`** — rejects JSON-RPC batch requests (audited as deny); captures agent identity from `initialize`'s `clientInfo.name`.
- **`startHttpIngress()`** — POST-only at `127.0.0.1:3002/<server-name>`; evaluates policy, injects stored `Authorization` header, forwards to the server's real URL via `fetch` (30s abort), relays upstream response verbatim, audits under the declared identity.
- Audit writes mask secrets and truncate blobs > 50KB (`AUDIT_MAX_BLOB_BYTES`) with a `__truncated` marker.
- `fireDenyWebhook()` — fire-and-forget POST to `webhook_url` setting on every deny.
- Graceful shutdown kills detached process groups on SIGTERM/SIGINT.

### Policy Engine — `src/policy/engine.ts`
- `loadPolicy(dir)` reads `context-fence.yaml` / `.yml` / `mcp-firewall.yaml` / `.context-fence.yaml`; falls back to `DEFAULT_POLICY` (5 rules + secret-pattern regexes for API keys, JWTs, `sk-`, `ghp_`, PEM blocks).
- `evaluateRequest(method, params)` order: **context filter** (secret-pattern detection) → merged rules (YAML + `custom_policies` DB overrides; `log_only` downgrades denies) → default **allow** (`No matching rule`).
- Robust matching: case/whitespace/symbol normalization (`rm -rf` ≡ `RM\n-RF`), base64 decoding, path/domain regex matching on leaf values.
- Rules hot-reload via chokidar.

### Built-in Policy — `backend/context-fence.yaml`
```yaml
rules:
  - block-destructive        # deny rm -rf, dd if, rm -fr in execute_command/bash
  - block-destructive-fs     # deny delete_file, delete_directory, move_file, edit_file...
  - block-file-navigation    # deny browser_navigate to file:/javascript:
  - block-cookie-exfil       # deny browser_evaluate with document.cookie / localStorage
```

### Database — `src/db/index.ts`
- better-sqlite3 at `data/context-fence.db` (`CF_DATA_DIR` overridable), WAL mode.
- Tables: `audit_log`, `agents`, `detected_agents`, `mcp_servers`, `protected_agents`, `settings`, `custom_policies`, `stats_history`.
- Auto-migration: adds `mcp_servers.headers` column if missing.

### API Routers (all JSON under `/api`)
| Router | Endpoints |
|---|---|
| `stats` | overview + 14-day history, timeline (`today/7d/30d`), outcomes, 5-axis health radar, top tools, most active |
| `policies` | merged rules w/ origin (Built-in/Modified/Custom), status, create/override/restore, toggle-mode, reload |
| `logs` | paginated audit log, JSON/CSV export |
| `settings` | get/put settings, retention run, webhook test, full backup export |
| `agents` | CRUD for API-key registered agents |
| `detect` | scan, list, manual add, delete (agent detection) |
| `firewall` | enforcement summary, top threats by rule, connected services |
| `servers` | list, test connection (ephemeral spawn), register (+immediate spawn), delete |
| `test-mcp` | send request through proxy, list servers |
| `protect` | protect/unprotect agent configs, summary |

### Agent Detection & Protection
- `src/agent-det/detector.ts` — detects Cursor, Claude Desktop, Claude Code, OpenCode, Codex, Copilot, Cline, Continue, Windsurf, Aider; parses agent DBs (via `sqlite3` CLI) + JSONL history for usage stats.
- `src/protect/rewriter.ts` — "Protect this agent": byte-for-byte timestamped backup of config, rewrites HTTP MCP entries to `http://127.0.0.1:3002/<server>` (via jsonc-parser), drops `oauth` blocks, registers real URL + auth header in `mcp_servers`, rolls back on failure. "Unprotect" hash-verifies the backup and restores byte-exact.
- Key ADR decision: per-agent config rewriting (opt-in) was chosen over an HTTP_PROXY wrapper (no agent supports MCP proxy env vars; CONNECT tunnels leave payloads opaque). Identity is self-asserted `clientInfo.name` — not authentication. See `backend/ADR-proxy-injection.md`.

### Framing — `src/mcp/framer.ts`
Auto-detects newline-delimited JSON (official MCP stdio) vs Content-Length (LSP-style) framing; skips non-JSON banner lines.

### Tests — `backend/test/`
Run manually via `npx tsx test/<file>.ts` (no `test` script in package.json):
- Unit: `src/mcp/framer.test.ts` (node:test).
- E2E: `e2e-harness.ts` (boots real backend on temp DB), policy positive cases, adversarial bypass suites, real-FS adversarial, Playwright adversarial, concurrency (50 parallel), mixed-concurrency (process-leak check), storage truncation, stop-check, plus a mock echo server.
- Playwright GUI/verification scripts in `backend/` (`n*-verify.mjs`, `gp*-*.mjs`, `n15-*.mjs`) exercise the live stack and screenshot into the opencode temp dir. `.playwright-mcp/` holds Playwright MCP logs.

---

## Frontend (`frontend/`)

**Stack:** Vite 6 + React 19 + TypeScript, Tailwind 4 (`@tailwindcss/postcss`), framer-motion, animejs, recharts, lucide-react, react-router-dom 7, firebase SDK.

**Scripts:**
- `npm run dev` — `vite` on port 5173 (proxies `/api` → `http://localhost:3000`)
- `npm run build` — `tsc -b && vite build` → `dist/` (~3.6 MB)

### Source Structure (`frontend/src/`)
- **Entry:** `main.tsx` (StrictMode + BrowserRouter + AuthProvider) → `App.tsx` route table: `/` Dashboard, `/agents`, `/agents/:type`, `/policies`, `/firewall`, `/test-mcp`, `/logs`, `/settings`, `/profile`, gated by onboarding storyboard + login.
- **Pages (10):** Dashboard, Firewall, Policies, AuditLog, Agents, AgentDetail, TestMCP, Settings, Profile, LoginPage.
- **Components:** `Layout.tsx` (sidebar), `Charts.tsx` (recharts wrappers: calls over time, health radar, policy outcomes, denied tools, most-active agent), `DoughnutChart`, `ChartTooltip`, `AddAgentModal`, `AddMCPModal`, `AnimatedBeam`, `DepthParallaxWords`, `Pattern`, `ErrorBoundary`, `LoadingScreen`, `OnboardingStoryboard`.
- **Hooks:** `useCachedFetch.ts` (stale-while-revalidate: in-memory Map + sessionStorage `cf_cache_v1`, deduped inflight, 60s default maxAge, 15s for security pages, visibility-change refresh, `invalidateCache()`), `useDebounce.ts`.
- **Lib:** `api.ts` (`BASE='/api'` fetch wrapper), `firebase.ts` (real Firebase project `context-fence`: Google/Apple/email auth, Firestore `users/{uid}` profiles, `window.electronAuth` bridge), `auth.tsx` (AuthProvider with mock dev user `dev@context-fence.local` fallback), `theme.ts` (light/dark/system via `data-theme`), `mockData.ts` (offline fallback).
- **Styling:** hand-rolled CSS design tokens in `styles.css` (cream light theme + dark variant) + Tailwind 4; no UI framework.
- **Security note:** `src/lib/firebase.ts` contains a hardcoded, committed Firebase API key for project `context-fence`.

---

## How It All Fits Together

```
┌─────────────┐   TCP JSON-RPC :3001 / HTTP MCP :3002    ┌──────────────┐
│ AI Agent    │ ───────────────────────────────────────▶ │ MCP Proxy    │
│ (Claude,    │                                          │ (evaluate)   │
│  OpenCode…) │                                          │  ─────────┐  │
└─────────────┘                                          │ policy    │  │
                                                         │ engine    │  │
┌─────────────┐   /api/*  (Express :3000)                └────────────┘  │
│ Dashboard   │ ◀───────────────────────────────────────   audit log     │
│ (Vite :5173 │      policy edits, stats, logs, protect    (SQLite)      │
│  dev proxy) │                                                    │     │
└─────────────┘                                                    ▼     │
                                          ┌──────────────┐   forwarded  │
                                          │ MCP Servers  │ ◀────────────┘
                                          │ (stdio/HTTP) │   allowed
                                          └──────────────┘   calls
```

- **Dev:** Vite on :5173 proxies all `/api/*` to Express on :3000. Agents point at the proxy ports (:3001 TCP, :3002 HTTP).
- **Prod (browser):** `NODE_ENV=production` Express serves `frontend/dist` and the API on :3000 — one process.
- **Protect flow:** "Protect this agent" rewrites the agent's MCP config to point HTTP servers at `127.0.0.1:3002/<server>`, storing real destinations + auth in `mcp_servers` with a byte-exact backup for restore.

---

## Build & Deployment

- **No CI, no Docker, no deployment scripts.**
- Frontend: `npm run build` (tsc + vite) → `frontend/dist`.
- Backend: `npm run build` (tsc) → `backend/dist`; `npm start` runs `node dist/index.js`.
- Production = backend serving the built frontend statically.
- **Retired desktop packaging (from git history):** `electron-builder --mac` → DMG/ZIP; `prepare-backend.sh` staged prod-only backend deps + dist + policy into `electron/staging/backend`, rebuilding `better-sqlite3` for Electron's ABI; Electron spawned the backend as a child, picked a free port, waited for `/api/health`, and served the packaged frontend via `static-server.js` (reverse-proxying `/api`). Removed from the working tree.

---

## Environment Variables (see `.env.example`)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Express API port |
| `CF_PROXY_PORT` | 3001 | TCP JSON-RPC MCP proxy port |
| `CF_PROXY_HTTP_PORT` | 3002 | HTTP MCP ingress port |
| `CF_POLICY_DIR` | cwd | Directory containing policy YAML |
| `CF_DATA_DIR` | `backend/data` | SQLite data directory |
| `NODE_ENV` | — | `production` serves built frontend |

---

## Quick Start

```bash
# Backend
cd backend && npm install && npm run dev        # :3000 (+ proxy :3001/:3002)

# Frontend
cd frontend && npm install && npm run dev       # :5173, proxies /api → :3000
```

Requires Node ≥ 20.


## v2 Docs Consolidation (2026-09-03)
- Removed `upload.md` (superseded by RELEASE.md)
- Consolidated changelog into CHANGELOG.md
