// N5 — concurrency: 50 simultaneous requests through the proxy (mixed
// allow/deny), asserting every request got a response, every response has a
// unique session id, exactly 50 audit rows were written, and the proxy stayed
// healthy throughout.

import { startHarness, cleanupTemp } from './e2e-harness.js';

const TOTAL = 50;

async function main() {
  const h = await startHarness();
  try {
    h.resetAudit();

    const tasks = Array.from({ length: TOTAL }, (_, i) => {
      const rm = i % 5 === 0; // 10 destructive, 40 benign
      return h.sendRequest('echo-a', 'tools/call', rm
        ? { name: 'execute_command', arguments: { command: 'rm -rf /tmp/evil' } }
        : { name: 'say_hello', arguments: { text: `msg-${i}` } });
    });

    const results = await Promise.all(tasks);
    await new Promise((r) => setTimeout(r, 200)); // let the last audit writes land

    const denied = results.filter((r) => r.decision === 'deny').length;
    const allowed = results.filter((r) => r.decision === 'allow').length;
    const failed = results.filter((r) => !r.ok && r.decision !== 'deny').length;
    const ids = results.map((r) => r.sessionId);
    const unique = new Set(ids).size;
    const count = h.countAudit();
    const avgMs = (results.reduce((s, r) => s + r.durationMs, 0) / results.length).toFixed(1);

    const alive = await h.sendRequest('echo-a', 'tools/call', { name: 'say_hello', arguments: { text: 'post-burst' } });

    console.log(`requests: ${TOTAL}, allow=${allowed}, deny=${denied}, unexpected failures=${failed}`);
    console.log(`unique session ids: ${unique}/${TOTAL}`);
    console.log(`audit rows: ${count}/${TOTAL}`);
    console.log(`avg duration: ${avgMs}ms`);
    console.log(`proxy healthy after burst: ${alive.ok && alive.decision === 'allow'}`);

    const pass = denied === 10 && allowed === 40 && failed === 0 && unique === TOTAL && count === TOTAL && alive.ok;
    console.log(`N5 RESULT: ${pass ? 'PASS' : 'FAIL'} — 50 concurrent requests, zero drops, proxy stable`);
    return pass;
  } finally {
    h.stop();
    cleanupTemp();
  }
}

main().then((pass) => process.exit(pass ? 0 : 1)).catch((err) => {
  console.error(err);
  process.exit(1);
});
