// N5 — playwright MCP adversarial pass against the REAL browser server.
// Playwright's attack surface: navigation to local/special URLs, arbitrary JS
// evaluation, exfiltration of page state, and large payload handling.
//
// Usage:
//   npx tsx test/playwright-adversarial.ts              # findings mode
//   npx tsx test/playwright-adversarial.ts --assert-fixed  # post-hardening

import { startHarness, cleanupTemp, type Harness, type AuditRow } from './e2e-harness.js';

const assertFixed = process.argv.includes('--assert-fixed');

// 300KB binary blob (base64 ~400KB) embedded in a data: URL — exercises
// large JSON-RPC request frames end-to-end (proxy parse -> evaluate -> audit).
const BIG_BLOB = Buffer.alloc(300 * 1024, 7).toString('base64');
const DATA_URL = `data:text/html;base64,${Buffer.from(`<title>Big Page</title><p>${BIG_BLOB}</p>`).toString('base64')}`;

interface Case {
  technique: string;
  call: { name: string; arguments: Record<string, unknown> };
  check: (h: Harness, row: AuditRow | undefined, res: Awaited<ReturnType<Harness['httpSendRequest']>>) => { pass: boolean; detail: string };
  expect: 'deny' | 'allow';
}

const CASES: Case[] = [
  {
    technique: '(iii) large params: navigate to data: URL with ~400KB base64 blob',
    call: { name: 'browser_navigate', arguments: { url: DATA_URL } },
    expect: 'allow',
    check: (_h, row, res) => {
      // P5-N3 storage decision: blobs >50KB are truncated to a marker with
      // byte_length + flag — verbatim storage is no longer the contract.
      const sentBytes = JSON.stringify({ name: 'browser_navigate', arguments: { url: DATA_URL } }).length;
      const stored = row?.params ?? '';
      let parsed: { __truncated?: boolean; byte_length?: number } | null = null;
      if (typeof stored === 'string') {
        try { parsed = JSON.parse(stored); } catch { /* plain JSON string, not a marker */ }
      }
      const truncated = !!parsed?.__truncated && typeof parsed.byte_length === 'number';
      const sizeRecorded = truncated && parsed.byte_length === sentBytes;
      const respOk = JSON.stringify(res.result ?? '').includes('Big Page');
      return {
        pass: !assertFixed || (truncated && sizeRecorded && respOk),
        detail: `params sent=${sentBytes}B stored=${typeof stored === 'string' ? stored.length : '?'}B truncated=${truncated} byte_length=${parsed?.byte_length ?? 'n/a'} responseOk=${respOk}${assertFixed ? '' : ' (storage decision — see evidence)'}`,
      };
    },
  },
  {
    technique: '(iv) large result: browser_evaluate returning 200KB string',
    call: { name: 'browser_evaluate', arguments: { function: "() => 'x'.repeat(200000)" } },
    expect: 'allow',
    check: (_h, _row, res) => {
      const result = JSON.stringify(res.result ?? '');
      const len = result.length;
      const hasLen = /200000/.test(result) || result.includes('xxx');
      return {
        pass: !assertFixed || (len > 200000 && hasLen),
        detail: `resultBytes=${len} >200k=${len > 200000} contentPresent=${hasLen}${assertFixed ? '' : ' (evidence mode)'}`,
      };
    },
  },
  {
    technique: '(i) navigate to file:///etc/passwd (real browser load)',
    call: { name: 'browser_navigate', arguments: { url: 'file:///etc/passwd' } },
    expect: 'deny',
    check: (_h, row, res) => {
      const decision = row?.decision ?? res.decision;
      const loaded = JSON.stringify(res.result ?? '').includes('root:');
      return { pass: decision === 'deny', detail: `decision=${decision} browserActuallyLoadedPasswd=${loaded} reason=${row?.reason ?? res.error}` };
    },
  },
  {
    technique: '(ii) browser_evaluate reading document.cookie (exfil pattern)',
    call: { name: 'browser_evaluate', arguments: { function: '() => document.cookie' } },
    expect: 'deny',
    check: (_h, row, res) => {
      const decision = row?.decision ?? res.decision;
      return { pass: decision === 'deny', detail: `decision=${decision} reason=${row?.reason ?? res.error}` };
    },
  },
  {
    technique: '(ii2) browser_run_code_unsafe reading localStorage (exfil pattern)',
    call: { name: 'browser_run_code_unsafe', arguments: { code: "JSON.stringify(localStorage.getItem('token'))" } },
    expect: 'deny',
    check: (_h, row, res) => {
      const decision = row?.decision ?? res.decision;
      return { pass: decision === 'deny', detail: `decision=${decision} reason=${row?.reason ?? res.error}` };
    },
  },
  {
    technique: 'CONTROL: benign navigate (must stay allow)',
    call: { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:8731/index.html' } },
    expect: 'allow',
    check: (_h, row, res) => {
      const decision = row?.decision ?? res.decision;
      const ok = JSON.stringify(res.result ?? '').includes('Sandbox Page');
      return { pass: decision === 'allow' && ok, detail: `decision=${decision} pageLoaded=${ok}` };
    },
  },
];

async function main() {
  const h = await startHarness({ real: true });
  try {
    let allPass = true;
    console.log(`${assertFixed ? 'POST-HARDENING' : 'FINDINGS'} — real playwright server\n`);
    for (const c of CASES) {
      const res = await h.httpSendRequest('playwright', 'tools/call', c.call);
      // Newest row for the agent (rowid DESC) is the row this call just wrote.
      const row = h.auditLog().find((r) => r.agent === 'api:playwright');
      const { pass, detail } = c.check(h, row, res);
      if (assertFixed && !pass) allPass = false;
      console.log(`${c.technique} | ${pass ? 'PASS' : 'FAIL'} | ${detail}`);
    }
    console.log(`\nN5 ${assertFixed ? 'RE-VERIFY' : 'FINDINGS'}: ${assertFixed ? (allPass ? 'PASS — playwright attack surface covered' : 'FAIL — see rows above') : 'evidence captured'}`);
    return allPass;
  } finally {
    h.stop();
    cleanupTemp();
  }
}

main().then((pass) => process.exit(pass ? 0 : 1)).catch((err) => {
  console.error(err);
  process.exit(1);
});
