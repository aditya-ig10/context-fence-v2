# ADR: Per-agent proxy injection via config rewriting (Context Fence)

Status: accepted. Date: 2026-08-02. Supersedes: nothing (complements
ADR-proxy-transport.md, the original stdio/TCP proxy decision).

## Problem

Context Fence audits traffic that *reaches its proxy* — but real agents never
dial the proxy. Their MCP configs point directly at their real servers (e.g.
OpenCode's `~/.config/opencode/opencode.jsonc` has `synthrun → https://
dashboard.synthrun.site/api/claude`). Only the dashboard's test-MCP flow and
manual harnesses connect to `localhost:3001` on purpose. Every audit row
written before this ADR therefore proves the *harness* worked, not that real
agent traffic is protected. This ADR decides how real agent traffic gets
routed through Context Fence transparently.

## Decision: option (a) — per-agent config rewriting (opt-in)

When the user clicks **Protect this agent** (Agents UI), Context Fence:

1. Reads the agent's real MCP config file (path from `AGENT_PATHS` in
   `agent-det/detector.ts`).
2. Writes a byte-for-byte timestamped backup: `<config>.cf-backup-<ts>`.
3. For every HTTP/remote MCP server entry in that config, registers (or
   updates) the server's *real* destination in the `mcp_servers` table, with
   any auth header the agent already holds (config `headers`, or the agent's
   OAuth token store, e.g. OpenCode's `mcp-auth.json`).
4. Rewrites the config entry so the agent connects to
   `http://127.0.0.1:3002/<server-name>` — Context Fence's HTTP MCP ingress
   — instead of the real endpoint. The `oauth` block is removed from the
   rewritten entry: auth is now applied by the proxy, so the agent must not
   try to run an OAuth discovery/authorization flow against the proxy URL.
5. Records the protection in a new `protected_agents` table (config path,
   backup path, original content hash, original `mcp_servers.headers`
   value), so **Unprotect / Restore** is a byte-exact revert.

The proxy's HTTP ingress evaluates every inbound JSON-RPC request with the
same `evaluateRequest` policy path as the TCP ingress, injects the stored
Authorization header when the client sends none, forwards to the real
endpoint, passes the upstream response through untouched, and writes the
audit row with the agent identity declared in the `initialize` handshake
(`clientInfo.name`).

## Why option (b) — env-var / HTTP(S)_PROXY wrapper injection — was ruled out

An `HTTP_PROXY`-style env var works for plain HTTP(S) traffic because a
gateway can terminate the request and re-issue it. MCP over HTTP is not plain
HTTP: it is JSON-RPC over a POST/SSE protocol with its own handshake
(`initialize`), its own header requirements (`Accept: application/json,
text/event-stream`), per-server bearer auth, and app-layer policy semantics
that must survive end-to-end. Concretely:

- None of the target agents (Cursor, Claude Desktop/Code, Codex, Copilot,
  Cline, Continue, Windsurf, Aider, OpenCode) document an environment
  variable that routes MCP traffic through a proxy. OpenCode and the MCP
  SDK clients build MCP connections directly to the configured URL; there is
  no MCP-aware HTTP proxy layer to hook.
- Even where generic `HTTP_PROXY` env vars are honored, the MCP client would
  CONNECT-tunnel to the real server through the proxy, which would leave the
  JSON-RPC payloads opaque to Context Fence — no evaluation, no audit, no
  identity. That is a blind pass-through, not protection.
- Option (a) additionally inherits the agent's own auth: the rewritten
  config entry lives in the same file the user already maintains, and the
  proxy stores the token it injects, so nothing that previously worked stops
  working (verified in N4 of the graph: functionality is preserved).

Decision: option (b) is explicitly ruled out, not assumed to work.

## Blast radius

- **Files touched per protected agent:** exactly one config file (the
  agent's MCP config, e.g. `~/.config/opencode/opencode.jsonc`), plus a
  sibling `.cf-backup-<ts>` copy. Nothing else on the user's machine is
  written. `mcp-auth.json` and the rest of the agent's data are read-only.
- **DB rows touched:** `mcp_servers` rows for the agent's HTTP servers
  (real URL + injected auth header; the pre-existing header value is stored
  in `protected_agents` for restore), and one `protected_agents` row.
- **Backup/restore guarantee:** the original file is never edited in place
  before the backup is written and hash-verified; Unprotect restores the
  backup bytes and verifies the result hash matches the pre-protect hash
  (N5 of the graph proves byte-for-byte restore). If a protect action
  fails mid-rewrite, the backup is used to restore the original file before
  the error is returned.
- **Scope:** deliberately opt-in and per-agent. Agents that were only ever
  *detected* are never touched; the UI labels them "Detected only — not
  protected" (N6).

## Transport deviation from the original ADR

The original TCP proxy listens on `127.0.0.1:3001` speaking newline-delimited
JSON-RPC over a raw socket. HTTP MCP clients (OpenCode `type: remote`,
streamable HTTP) cannot use that transport, and one port cannot cleanly
multiplex raw JSON-RPC sockets and HTTP/1.1 (keep-alive, chunked, SSE)
without content-sniffing. The HTTP MCP ingress therefore listens on
`127.0.0.1:3002` (`CF_PROXY_HTTP_PORT`). Rewritten config URLs point at
`3002/<server-name>`; 3001 remains the TCP ingress. Both are Context Fence
owned and both run the same `evaluateRequest` → audit pipeline.

## Auth handling (documented limitation)

The proxy injects the bearer token found in the agent's own store
(`mcp-auth.json` access token for that server URL, or the config's
`headers.Authorization`) into the forwarded request when the client sends
none. The token is stored in the local SQLite `mcp_servers.headers` column —
the same trust domain as the agent config file, which already contains the
OAuth `clientSecret`. If the stored token expires, the upstream 401 is passed
back to the agent verbatim; the agent surfaces it as an MCP connection error
(no data corruption, no silent degradation).

## Agent identity

The HTTP ingress captures `clientInfo.name` from the first `initialize` per
(remote address, server) and audits subsequent requests from that source
under the declared name — the same self-asserted identity model the TCP
ingress adopted in graph 11 (N5). It is identity as MCP defines it, not
authentication.
