# MCP Firewall (Context Fence)

**v2.0.0** — local-first, notify-only update checks, realtime policy enforcement.

A **local-first security control plane for AI coding agents**. MCP Firewall sits between AI agents (Claude Desktop / Claude Code, Cursor, OpenCode, Codex, GitHub Copilot, Cline, Continue, Windsurf, Aider) and their MCP servers, intercepting every tool call so it can be **policy-checked, logged, and blocked or allowed** — with a full dashboard for monitoring what your agents actually do.

```
AI Agent ──mcp──▶ MCP Firewall Proxy (:3001) ──mcp──▶ MCP Servers
                         │
                         ├──▶ Policy Engine   (context-fence.yaml + DB overrides)
                         ├──▶ Audit Log       (SQLite)
                         └──▶ API + Dashboard (Express :3000 → Vite :5173)
```

## Features

- **MCP proxy** — agents point at `localhost:3001`; every `tools/call` (and other JSON-RPC methods) is inspected before it reaches the server.
- **Policy engine** — YAML rules with `action` (allow/deny/log), target `methods`, `tools`, and `param_contains` matching; rules hot-reload on file change and can be edited live from the GUI.
- **Built-in + custom policies** — built-ins from `backend/context-fence.yaml`; the GUI can override or extend them (stored as `custom_policies` rows in SQLite, origin shown as Built-in / Modified / Custom).
- **Audit log** — every decision (allow / deny / log) with tool, reason, duration and timestamp; retention cleanup configurable from Settings.
- **Agent detection** — recognises common agent CLIs and their configs to show per-agent usage.
- **Dashboard** — request distribution (Allowed vs Blocked), system-health radar (Latency, Throughput, Reliability, Coverage, Efficiency per decision), calls-over-time, denied tools, most active agent.
- **Firewall page** — live summary: policy-enforcement doughnut, node topology, and top threats grouped by rule with expandable historical variants.
- **Dark mode** — full light/dark theme (manual override or OS preference), built on shared design tokens.

## Install

Latest release: **v2.0.0** — [Download from contextfence.dev/downloads](https://contextfence.dev/downloads) · [macOS](#macos-homebrew-recommended) · [Windows](#windows-installer)

### macOS (Homebrew — recommended)

```bash
brew tap aditya-ig10/context-fence
brew trust --cask aditya-ig10/context-fence/context-fence
brew install --cask context-fence
```

The app is ad-hoc signed, so the cask clears the quarantine flag on install; no Gatekeeper pop-ups. First launch can take ~10 seconds (it starts a small built-in server). Step-by-step friend-safe instructions live in [INSTALL.md](INSTALL.md).

### Windows (installer)

1. Download `Context-Fence-Setup-2.0.0-x64.exe` from [contextfence.dev/downloads](https://contextfence.dev/downloads).
2. Run it. The installer is **unsigned**, so SmartScreen shows a blue prompt — click **More info → Run anyway**.
3. Per-user install: no admin rights needed; you choose the install directory.

## Updating

- **In-app**: open **Settings → Updates → Check for Updates**. It compares your version against the latest GitHub release — notify-only, it never downloads or installs anything.
- **macOS (Homebrew)**: 
  ```bash
  brew update
  brew upgrade --cask context-fence
  ```
  *(If Homebrew doesn't see the new version immediately, run `brew update` to refresh the tap, or `brew reinstall --cask context-fence` to force a redownload).*
- **Windows**: download the new installer from [contextfence.dev/downloads](https://contextfence.dev/downloads) and run it.
- Your data (audit log, policies, connectors, agent registrations) lives in the app's data folder and is **kept on upgrade** — both installers set `deleteAppDataOnUninstall: false`.

## Uninstalling

- **macOS**: `brew uninstall --cask context-fence` (data kept). Add `--zap` to also delete the audit log and policies from `~/Library/Application Support/Context Fence`.
- **Windows**: Settings → Apps → Context Fence → Uninstall. The uninstaller removes the app but keeps your data under `%APPDATA%`.

## Repository layout

```
backend/               Express API (:3000) + MCP proxy (:3001) + policy engine
  src/index.ts         API server bootstrap + route mounting
  src/mcp/proxy.ts     MCP JSON-RPC proxy with policy interception
  src/policy/engine.ts Rule evaluation (loadPolicy, evaluateRequest)
  src/routes/          stats, policies, logs, settings, agents, firewall, servers, test-mcp, detect
  src/db/              SQLite (better-sqlite3) — data/context-fence.db
  context-fence.yaml   Built-in policy rules
  scripts/             mock-mcp-server.mjs (stdio test server)
frontend/              Vite + React 19 dashboard (:5173)
  src/pages/           Dashboard, Firewall, Policies, AuditLog, Agents, AgentDetail,
                       TestMCP, Settings, Profile
  src/components/      Charts (recharts), DoughnutChart, ChartTooltip, Layout, …
  src/hooks/           useCachedFetch (stale-while-revalidate cache layer)
```

## Quick start

Requires Node ≥ 20. Two processes: the backend (API + proxy) and the frontend.

```bash
# 1. Backend — API on :3000, MCP proxy on :3001
cd backend
npm install
npm run dev          # or: npm run build && npm start

# 2. Frontend — dashboard on http://localhost:5173
cd frontend
npm install
npm run dev
```

The dashboard opens with a mock local session (no Firebase required). Optional extras:

```bash
# Seed some demo agent entries
cd backend && npx tsx src/scripts/seed.ts

# Mock stdio MCP server used by engine/proxy tests
cd backend && node scripts/mock-mcp-server.mjs
```

### Pointing an agent at the firewall

Configure the agent's MCP server URL to `http://localhost:3001` (the proxy). The proxy forwards to real MCP servers registered through the dashboard/TestMCP page, evaluates each `tools/call` against the merged policy set, and records the decision in the audit log.

## Policies

Rules are plain YAML, e.g. from `backend/context-fence.yaml`:

```yaml
rules:
  - name: block-destructive
    action: deny
    reason: Destructive command blocked
    methods:
      - tools/call
    tools:
      - execute_command
      - bash
    param_contains:
      - rm -rf
      - dd if
```

- Matching: a rule applies when the call's method is in `methods`, the tool name is in `tools` (case-insensitive), and any argument contains one of `param_contains`.
- The engine's `evaluateRequest` checks **deny** rules before allow rules; no match → allowed with reason `No matching rule`.
- Built-ins can be overridden or extended from **Policies** in the dashboard (origin marker: Built-in / Modified / Custom); override rows live in SQLite and replace the YAML rule in place — YAML is never rewritten.
- Policy files hot-reload via `chokidar` (`CF_POLICY_DIR` overrides the policy directory).

## API overview

| Route | Purpose |
|---|---|
| `/api/stats/*` | health radar (per-decision 5-axis scores over 24 h), timeline, outcomes, top-tools, most-active |
| `/api/policies` | merged policy list, create/override/restore/delete/import |
| `/api/logs` | audit log query + retention |
| `/api/settings/:key` | typed settings store (dashboard window/categories, theme, retention, webhook, log-only) |
| `/api/agents`, `/api/detect` | registered + detected agents |
| `/api/firewall` | summary: enforcement totals, threats grouped by rule, servers |
| `/api/servers`, `/api/test-mcp` | MCP server registry + connection testing |

All routes are plain JSON under `/api`; the frontend dev server proxies them to `:3000`.

## Frontend data layer

`useCachedFetch` (frontend/src/hooks) is a stale-while-revalidate cache with a sessionStorage mirror: pages render cached data instantly on navigation, revalidate in the background, and purge keys on mutation. Policies/AuditLog use a tighter 15 s window so security-relevant changes propagate quickly across tabs.

## Verification scripts

Playwright GUI/API verification suites live in `backend/` (`n15-verify.mjs` and friends) and exercise the live stack: chart rendering, tooltip values against raw SQL, dark-mode computed styles, policy override round-trips through the real proxy, and cache staleness timing.

## Tech stack

- **Backend**: Node + Express, better-sqlite3, ws, js-yaml, chokidar, tsx (dev)
- **Frontend**: React 19, Vite, react-router, recharts, framer-motion, lucide-react (optional Firebase auth)
- **Design**: hand-rolled CSS design tokens (cream light theme + dark), no UI framework
