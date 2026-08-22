// N3 — real-server smoke test through the FULL proxy path:
// backend child (real spawn via mcp_servers rows registered through the real
// config->detector flow) -> evaluateRequest -> forward -> real server executes
// -> response -> audit row. One benign request per real server.

import { startHarness, cleanupTemp } from './e2e-harness.js';

async function main() {
  const h = await startHarness({ real: true });
  try {
    const spawnInfo = await fetch(`http://127.0.0.1:${h.httpPort}/api/test-mcp/servers`).then((r) => r.json()) as { servers: { name: string; pid: number | undefined }[] };
    console.log('spawned servers:', JSON.stringify(spawnInfo.servers));

    console.log('\n--- filesystem: read a real file ---');
    const fsRes = await h.httpSendRequest('filesystem', 'tools/call', {
      name: 'read_file',
      arguments: { path: '/tmp/cf-fs-sandbox/notes.txt' },
    });
    const fsContent = JSON.stringify(fsRes.result ?? null).slice(0, 300);
    console.log(`read_file -> ok=${fsRes.ok} decision=${fsRes.decision} durationMs=${fsRes.durationMs}`);
    console.log(`content: ${fsContent}`);

    console.log('\n--- playwright: navigate to safe local page ---');
    const pwRes = await h.httpSendRequest('playwright', 'tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'http://127.0.0.1:8731/index.html' },
    });
    const pwResult = JSON.stringify(pwRes.result ?? null);
    console.log(`browser_navigate -> ok=${pwRes.ok} decision=${pwRes.decision} durationMs=${pwRes.durationMs}`);
    console.log(`result has snapshot content: ${pwResult.includes('Sandbox Page') || pwResult.length > 0}`);

    console.log('\n--- matching audit rows ---');
    const rows = h.auditLog().slice(-4);
    for (const r of rows) {
      console.log(`${r.id.slice(0, 8)} decision=${r.decision} tool=${r.tool} method=${r.method} duration_ms=${r.duration_ms}`);
    }

    const fsOk = fsRes.ok && typeof fsRes.result === 'object' && JSON.stringify(fsRes.result).includes('hello from the sandbox');
    const pwOk = pwRes.ok && pwResult.includes('Sandbox Page');
    const fsRow = rows.find((r) => r.tool === 'read_file');
    const pwRow = rows.find((r) => r.tool === 'browser_navigate');
    const durOk = fsRow && fsRow.duration_ms >= 10 && pwRow && pwRow.duration_ms >= 10;
    const pass = fsOk && pwOk && durOk;
    console.log(`\nN3 RESULT: ${pass ? 'PASS' : 'FAIL'} — real responses with real duration (fs=${fsRow?.duration_ms}ms, pw=${pwRow?.duration_ms}ms)`);
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
