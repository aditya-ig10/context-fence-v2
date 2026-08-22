// P5-N1 + P5-N2 — mixed real-server concurrency + process leak check.
//
// N1: 50 concurrent requests through the full proxy — 25 to the real
//     @modelcontextprotocol/server-filesystem child, 25 to the real
//     @playwright/mcp child — mixed allow/deny per the committed policy
//     (context-fence.yaml). Criterion: exactly 50 audit_log rows, 25 per
//     server, with the expected decision mix per server.
//
// N2: ps snapshots of playwright browser processes and filesystem-server
//     node processes, taken immediately before the harness starts and again
//     30s after teardown. Criterion: after-count must return to baseline and
//     no orphaned (PPID 1) browser/server processes may remain.

import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { startHarness, cleanupTemp } from './e2e-harness.js';

const SANDBOX = '/tmp/cf-fs-sandbox';

interface ProcEntry {
  pid: number;
  ppid: number;
  cmd: string;
}

function snapshot(label: string): ProcEntry[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8' });
  const rows: ProcEntry[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  const isBrowser = (c: string) => /ms-playwright|chrome-headless-shell|Chromium/i.test(c);
  const isFsServer = (c: string) => /@modelcontextprotocol\/server-filesystem|server-filesystem/i.test(c);
  const isPwServer = (c: string) => /@playwright\/mcp/i.test(c);
  const browsers = rows.filter((r) => isBrowser(r.cmd));
  const fsNodes = rows.filter((r) => isFsServer(r.cmd));
  const pwNodes = rows.filter((r) => isPwServer(r.cmd));
  console.log(`[n2] ${label}: browser procs=${browsers.length} fs-server node procs=${fsNodes.length} playwright-server procs=${pwNodes.length}`);
  for (const p of browsers) console.log(`[n2]   browser ${p.pid} ppid=${p.ppid} ${p.cmd.slice(0, 140)}`);
  for (const p of fsNodes) console.log(`[n2]   fs-node ${p.pid} ppid=${p.ppid} ${p.cmd.slice(0, 140)}`);
  for (const p of pwNodes) console.log(`[n2]   pw-node ${p.pid} ppid=${p.ppid} ${p.cmd.slice(0, 140)}`);
  return { browsers, fsNodes, pwNodes, rows };
}

async function main() {
  mkdirSync(SANDBOX, { recursive: true });
  writeFileSync(`${SANDBOX}/hello.txt`, 'hello from mixed-concurrency', 'utf-8');

  const before = snapshot('BEFORE (baseline)');

  const h = await startHarness({ real: true });
  h.resetAudit();
  try {
    // 25 filesystem calls: 20 benign read_file (allow), 5 destructive
    // edit_file (deny via block-destructive-fs).
    const fsTasks = Array.from({ length: 25 }, (_, i) =>
      h.httpSendRequest('filesystem', 'tools/call',
        i % 5 === 0
          ? { name: 'edit_file', arguments: { path: `${SANDBOX}/hello.txt`, edits: [{ oldText: 'hello', newText: 'bye' }] } }
          : { name: 'read_file', arguments: { path: `${SANDBOX}/hello.txt` } }),
    );

    // 25 playwright calls: 9 real data: navigations (allow), 8 file://
    // navigations (deny via block-file-navigation), 8 cookie evals (deny via
    // block-cookie-exfil). Only the 9 data: navigations touch the browser.
    const pwTasks = Array.from({ length: 25 }, (_, i) => {
      const kind = i % 3;
      if (kind === 0) return h.httpSendRequest('playwright', 'tools/call', { name: 'browser_navigate', arguments: { url: `data:text/html,page${i}` } });
      if (kind === 1) return h.httpSendRequest('playwright', 'tools/call', { name: 'browser_navigate', arguments: { url: 'file:///etc/passwd' } });
      return h.httpSendRequest('playwright', 'tools/call', { name: 'browser_evaluate', arguments: { function: '() => document.cookie' } });
    });

    const results = await Promise.all([...fsTasks, ...pwTasks]);
    await new Promise((r) => setTimeout(r, 500)); // let the last audit writes land

    const during = snapshot('DURING (harness up, browser exercised)');

    const rows = h.auditLog();
    const total = rows.length;
    const fsRows = rows.filter((r) => r.agent === 'api:filesystem');
    const pwRows = rows.filter((r) => r.agent === 'api:playwright');
    const fsDeny = fsRows.filter((r) => r.decision === 'deny').length;
    const fsAllow = fsRows.filter((r) => r.decision === 'allow').length;
    const pwDeny = pwRows.filter((r) => r.decision === 'deny').length;
    const pwAllow = pwRows.filter((r) => r.decision === 'allow').length;
    const timedOut = results.filter((r) => !r.ok && r.decision !== 'deny').length;

    console.log(`[n1] requests sent: 50 (filesystem=25, playwright=25)`);
    console.log(`[n1] audit rows total: ${total} (must be 50)`);
    console.log(`[n1] filesystem rows: ${fsRows.length}/25  allow=${fsAllow} deny=${fsDeny}`);
    console.log(`[n1] playwright rows: ${pwRows.length}/25  allow=${pwAllow} deny=${pwDeny} (mix: 9 data: allow, 8 file:// deny, 8 cookie deny)`);
    console.log(`[n1] unexpected failures/timeouts: ${timedOut}`);
    console.log(`[n1] unaccounted rows (other agents): ${total - fsRows.length - pwRows.length}`);

    const passN1 =
      total === 50 &&
      fsRows.length === 25 && fsDeny === 5 && fsAllow === 20 &&
      pwRows.length === 25 && pwDeny === 16 && pwAllow === 9 &&
      timedOut === 0;

    console.log(`N1 RESULT: ${passN1 ? 'PASS' : 'FAIL'} — mixed 25/25 real-server concurrency, 50/50 rows exact`);
    return { passN1, during, before };
  } finally {
    h.stop();
  }
}

main().then(async ({ passN1, during, before }) => {
  // N2: leak re-check 30s after teardown.
  await new Promise((r) => setTimeout(r, 30000));
  const after = snapshot('AFTER (30s post-teardown)');  const orphanBrowsers = after.rows.filter((r) => r.ppid === 1 && /ms-playwright|chrome-headless-shell|Chromium/i.test(r.cmd));
  const orphanFs = after.rows.filter((r) => r.ppid === 1 && /server-filesystem/i.test(r.cmd));
  console.log(`[n2] orphans: chromium/playwright=${orphanBrowsers.length} fs-server=${orphanFs.length}`);
  // Meaningful leak check: the browser must have existed DURING the run
  // (proving it was exercised) and be fully gone afterwards.
  const passN2 = during.browsers.length > 0 &&
    after.browsers.length <= before.browsers.length &&
    after.fsNodes.length <= before.fsNodes.length &&
    orphanBrowsers.length === 0 && orphanFs.length === 0;
  console.log(`N2 RESULT: ${passN2 ? 'PASS' : 'FAIL'} — browser alive during run (${during.browsers.length}), zero leaked processes after teardown`);  cleanupTemp();
  process.exit(passN1 && passN2 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  cleanupTemp();
  process.exit(1);
});
