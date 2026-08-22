// P5-N3 — storage decision verification: audit_log must truncate large
// param/raw blobs above AUDIT_MAX_BLOB_BYTES (50KB), storing a
// __truncated marker with original byte_length + preview instead of the
// verbatim blob. Small calls must remain stored verbatim (no marker).

import { startHarness, cleanupTemp } from './e2e-harness.js';

const DATA_URL = `data:text/html,${Buffer.from(`<html><body>${'B'.repeat(40_000)}</body></html>`).toString('base64')}`;

async function main() {
  const h = await startHarness({ real: true });
  h.resetAudit();
  try {
    // Large blob: >50KB params JSON — must be truncated with flag + byte_length.
    const big = await h.httpSendRequest('playwright', 'tools/call', { name: 'browser_navigate', arguments: { url: DATA_URL } });
    await new Promise((r) => setTimeout(r, 300));
    const bigRow = h.auditLog().find((r) => r.agent === 'api:playwright');
    let bigParsed: { __truncated?: boolean; byte_length?: number; preview?: string } | null = null;
    if (bigRow?.params) {
      try { bigParsed = JSON.parse(bigRow.params); } catch { /* not a marker */ }
    }
    const bigOk = bigParsed?.__truncated === true &&
      bigParsed.byte_length === JSON.stringify({ name: 'browser_navigate', arguments: { url: DATA_URL } }).length &&
      typeof bigParsed.preview === 'string' &&
      (bigParsed.preview?.length ?? 0) <= 50_000 &&
      big.ok;

    // Small call: verbatim, no marker.
    const small = await h.httpSendRequest('filesystem', 'tools/call', { name: 'read_file', arguments: { path: '/tmp/cf-fs-sandbox/hello.txt' } });
    await new Promise((r) => setTimeout(r, 300));
    const smallRow = h.auditLog().find((r) => r.agent === 'api:filesystem');
    const smallVerbatim = !!smallRow?.params?.includes('read_file') && !smallRow?.params?.includes('__truncated');

    console.log(`[n3] large call: responseOk=${big.ok} decision=${big.decision}`);
    console.log(`[n3] large row params (${bigRow?.params?.length ?? 0} bytes stored):`);
    console.log(`  ${bigRow?.params?.slice(0, 220)}...`);
    console.log(`[n3] large row: __truncated=${bigParsed?.__truncated} byte_length=${bigParsed?.byte_length} previewBytes=${bigParsed?.preview?.length ?? 'n/a'}`);
    console.log(`[n3] small call: decision=${small.decision} verbatim=${smallVerbatim}`);

    const pass = bigOk && smallVerbatim;
    console.log(`N3 RESULT: ${pass ? 'PASS' : 'FAIL'} — blobs >50KB truncated w/ flag+byte_length, small calls verbatim`);
    return pass;
  } finally {
    h.stop();
    cleanupTemp();
  }
}

main().then((pass) => process.exit(pass ? 0 : 1)).catch((err) => {
  console.error(err);
  cleanupTemp();
  process.exit(1);
});
