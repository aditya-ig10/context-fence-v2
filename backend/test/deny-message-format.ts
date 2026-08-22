// Wire-level verification of the deny error message format across all three
// call sites. The audit_log reason stays the RAW policy reason (machine
// readable), but every JSON-RPC error an agent receives — the thing its UI
// relays to the end user — must carry the framed, unambiguous message:
//   "Request blocked by Context Fence: <rule reason>"
//
// Transports exercised:
//   1. TCP stdio ingress (:3001) — raw JSON-RPC over a socket (sendRaw, the
//      exact bytes most CLI agents parse).
//   2. HTTP MCP ingress (:3002/<server>) — the transport OpenCode / Claude
//      Desktop route through after "protect this agent" rewrites.
//   3. /api/test-mcp — the dashboard's own probe path (sendRequest helper).
//
// Run: npx tsx test/deny-message-format.ts

import { startHarness, cleanupTemp, type Harness } from './e2e-harness.js';

const PREFIX = 'Request blocked by Context Fence: ';
const EXPECTED = `Destructive command blocked`; // block-destructive rule reason

// Deterministic deny: execute_command / bash + `rm -rf` hits block-destructive.
const denyCall = {
  jsonrpc: '2.0',
  id: 'deny-1',
  method: 'tools/call',
  params: { name: 'execute_command', arguments: { command: 'rm -rf /tmp/evil' } },
};

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`  PASS ${label} — ${detail}`); }
  else { failed++; console.log(`  FAIL ${label} — ${detail}`); }
}

async function main(): Promise<boolean> {
  const h: Harness = await startHarness();

  // ── 1. TCP stdio ingress (:proxyPort) — raw bytes from the proxy ──
  const raw = await h.sendRaw(denyCall);
  const reply = raw.messages.find(
    (m) => (m as { id?: unknown }).id !== undefined && String((m as { id?: unknown }).id) === 'deny-1',
  ) as { error?: { message?: string }; result?: unknown } | undefined;
  const tcpMessage = reply?.error?.message ?? '(no error message)';
  check('TCP  :3001', reply?.error?.message === `${PREFIX}${EXPECTED}`, `error.message="${tcpMessage}"`);

  // ── 2. HTTP MCP ingress (:httpIngressPort/echo-a) — opencode remote path ──
  let httpMessage = '(no call made)';
  try {
    const res = await fetch(`http://127.0.0.1:${h.httpIngressPort}/echo-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(denyCall),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string }; result?: unknown };
    httpMessage = body?.error?.message ?? '(no error field in response)';
  } catch (err) {
    httpMessage = `(fetch failed: ${(err as Error).message})`;
  }
  check('HTTP :3002', httpMessage === `${PREFIX}${EXPECTED}`, `error.message="${httpMessage}"`);

  // ── 3. /api/test-mcp — dashboard probe path (sendRequest helper) ──
  const api = await h.httpSendRequest('echo-a', 'tools/call', denyCall.params);
  check('/api/test-mcp', api.error === `${PREFIX}${EXPECTED}`, `error="${api.error}"`);

  // ── Audit log must keep the RAW rule reason (machine-readable, unchanged) ──
  const rows = h.auditLog().filter((r) => r.session_id === (api.sessionId || 'deny-1') || r.tool === 'execute_command');
  const auditReason = rows.map((r) => `${r.session_id}:${r.reason}`).join(' | ');
  check('audit reason raw', auditReason.includes(EXPECTED) && !auditReason.includes(PREFIX), `audit_reasons=[${auditReason}]`);

  h.stop();
  cleanupTemp();
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

const isMain = process.argv[1] && process.argv[1].endsWith('deny-message-format.ts');
if (isMain) {
  main().then((pass) => process.exit(pass ? 0 : 1)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}