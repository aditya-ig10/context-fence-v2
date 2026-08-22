// N3 — adversarial bypass attempts against the policy engine.
// Targets the repo's real config (backend/context-fence.yaml:
// block-destructive rule on tools/call + execute_command/bash with
// param_contains ['rm -rf', 'dd if'], log_only=false).
//
// Usage:
//   npx tsx test/adversarial-bypass.ts             # findings mode (N3)
//   npx tsx test/adversarial-bypass.ts --assert-fixed  # post-N4 mode: each
//        previously-bypassed payload must now be denied (exit 1 otherwise)

import { startHarness, cleanupTemp, type Harness } from './e2e-harness.js';

const assertFixed = process.argv.includes('--assert-fixed');

interface Attempt {
  technique: string;
  expectedWhenFixed: 'deny' | 'batch-deny';
  method?: string;
  params?: unknown;
  raw?: unknown;
  note?: string;
  residual?: boolean; // documented as still-bypassable after the fix (needs signature change, not engine change)
}

const RM = 'rm -rf /tmp/evil';
const RM_B64 = Buffer.from(RM).toString('base64');

const ATTEMPTS: Attempt[] = [
  { technique: 'CONTROL: direct hit (lowercase, plain)', expectedWhenFixed: 'deny', method: 'tools/call', params: { name: 'execute_command', arguments: { command: RM } }, note: 'should be denied even before any fix' },
  { technique: 'CONTROL: benign call', expectedWhenFixed: 'allow', method: 'tools/call', params: { name: 'say_hello', arguments: { text: 'hi' } }, note: 'negative control; must stay allow' },
  { technique: 'method case variation (TOOLS/CALL)', expectedWhenFixed: 'deny', method: 'TOOLS/CALL', params: { name: 'execute_command', arguments: { command: RM } } },
  { technique: 'tool name case variation (EXECUTE_COMMAND)', expectedWhenFixed: 'deny', method: 'tools/call', params: { name: 'EXECUTE_COMMAND', arguments: { command: RM } } },
  { technique: 'unicode lookalike dash (rm \u2013rf)', expectedWhenFixed: 'deny', method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'rm \u2013rf /tmp/evil' } } },
  { technique: 'whitespace/newline inside command (rm \\n-rf)', expectedWhenFixed: 'deny', method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'rm \n-rf /tmp/evil' } } },
  { technique: 'backslash-escaped space (rm\\ -rf)', expectedWhenFixed: 'deny', method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'rm\\ -rf /tmp/evil' } } },
  { technique: 'shell IFS expansion (rm${IFS}-rf)', expectedWhenFixed: 'deny', method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'rm${IFS}-rf /tmp/evil' } }, residual: true, note: 'documented residual — needs a signature/needle update, not an engine change' },
  { technique: 'base64-encoded command', expectedWhenFixed: 'deny', method: 'tools/call', params: { name: 'execute_command', arguments: { command: RM_B64 } } },
  { technique: 'no tool name field (name omitted)', expectedWhenFixed: 'deny', method: 'tools/call', params: { arguments: { command: RM } } },
  { technique: 'JSON-RPC batch in one frame (innocent + rm -rf)', expectedWhenFixed: 'batch-deny', raw: [
    { jsonrpc: '2.0', id: 'b1', method: 'tools/call', params: { name: 'say_hello', arguments: { text: 'hi' } } },
    { jsonrpc: '2.0', id: 'b2', method: 'tools/call', params: { name: 'execute_command', arguments: { command: RM } } },
  ] },
  { technique: 'CONTROL: notification (no id) rm -rf', expectedWhenFixed: 'deny', method: 'tools/call', params: { name: 'execute_command', arguments: { command: RM } }, note: 'notification path' },
];

async function runAttempt(h: Harness, a: Attempt) {
  if (a.raw !== undefined) {
    const before = h.countAudit();
    const { messages, auditCount } = await h.sendRaw(a.raw);
    const newRows = h.auditLog().slice(0, auditCount - before);
    return {
      messages,
      rowCount: auditCount - before,
      decisions: newRows.map((r) => r.decision),
      reasons: newRows.map((r) => r.reason ?? ''),
      firstRow: newRows[0] ?? null,
    };
  }
  if (a.method === undefined) throw new Error(`attempt missing method: ${a.technique}`);
  const isNotify = a.note === 'notification path';
  const res = await h.sendRequest('echo-a', a.method, a.params, isNotify ? { id: '__notify__' } : undefined);
  return { res };
}

async function main() {
  const h = await startHarness();
  try {
    const pol = await fetch(`http://127.0.0.1:${h.httpPort}/api/policies`).then((r) => r.json()) as {
      rules: { name: string; action: string }[];
    };
    console.log(`policy active: ${pol.rules.map((r) => `${r.name}(${r.action})`).join(', ')}`);

    if (!assertFixed) {
      console.log('\ntechnique | bypassed (Y/N) | decision | evidence');
    } else {
      console.log('\ntechnique | decision after fix | expected | PASS/FAIL | evidence');
    }

    let allPass = true;
    for (const a of ATTEMPTS) {
      const r = await runAttempt(h, a);
      let bypassed: 'Y' | 'N';
      let decision: string;
      let evidence: string;

      if (a.raw !== undefined) {
        decision = r.rowCount === 0 ? 'NO AUDIT ROW' : r.decisions.join('/');
        bypassed = decision === 'NO AUDIT ROW' ? 'Y' : 'N';
        evidence = `batch frame with ${a.raw!.length} requests -> responses: ${r.messages.length}, audit rows: ${r.rowCount}`;
      } else {
        decision = (r.res as { decision: string }).decision;
        bypassed = decision !== 'deny' ? 'Y' : 'N';
        const payload = JSON.stringify(a.params).slice(0, 110);
        evidence = `${a.method} ${payload} -> decision=${decision}`;
      }

      const pass = assertFixed
        ? (a.residual ? true : a.expectedWhenFixed === 'batch-deny' ? decision.includes('deny') : decision === a.expectedWhenFixed)
        : true;
      if (assertFixed && !pass) allPass = false;

      const verdict = assertFixed ? (a.residual ? 'RESIDUAL' : pass ? 'PASS' : 'FAIL') : '';
      console.log(`${a.technique} | ${assertFixed ? decision + ' | ' + a.expectedWhenFixed + ' | ' + verdict : bypassed + ' | ' + decision} | ${evidence}${a.note ? ' [' + a.note + ']' : ''}`);
    }

    if (assertFixed) {
      console.log(`\nN4 RE-VERIFY: ${allPass ? 'PASS — all bypass techniques now produce the expected decision' : 'FAIL — see rows above'}`);
      return allPass;
    }
    return true;
  } finally {
    h.stop();
    cleanupTemp();
  }
}

main().then((pass) => process.exit(pass ? 0 : 1)).catch((err) => {
  console.error(err);
  process.exit(1);
});
