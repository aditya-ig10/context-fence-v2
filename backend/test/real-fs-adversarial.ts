// N4 — destructive-op and secret handling against the REAL filesystem MCP
// server. The server's real tool vocabulary (no delete_file! move_file /
// edit_file / write_file) differs from the synthetic execute_command/rm -rf
// shapes Prompts 1-3 tested — this suite measures whether the policy engine
// generalizes.
//
// Usage:
//   npx tsx test/real-fs-adversarial.ts          # findings mode
//   npx tsx test/real-fs-adversarial.ts --assert-fixed  # post-hardening: expect
//        deny for destructive intent, [REDACTED] in audit params for secrets

import { startHarness, cleanupTemp, type Harness, type AuditRow } from './e2e-harness.js';

const assertFixed = process.argv.includes('--assert-fixed');
const FAKE_SECRET = 'OPENAI_API_KEY=sk-fake1234567890abcdefgh';

interface Case {
  technique: string;
  call: { name: string; arguments: Record<string, unknown> };
  check: (h: Harness, row: AuditRow | undefined, res: Awaited<ReturnType<Harness['httpSendRequest']>>) => { pass: boolean; detail: string };
}

const CASES: Case[] = [
  {
    technique: '(b1) read_file on dummy .env (secret lives in response, not params)',
    call: { name: 'read_file', arguments: { path: '/tmp/cf-fs-sandbox/.env' } },
    check: (_h, row, res) => {
      const resp = JSON.stringify(res.result ?? '');
      const secretInResponse = resp.includes('sk-fake1234567890abcdefgh');
      const maskedInResponse = resp.includes('[REDACTED]');
      const params = row?.params ? JSON.parse(row.params as string) : {};
      const secretInParams = JSON.stringify(params).includes('sk-fake1234567890abcdefgh');
      if (assertFixed) {
        return {
          pass: !secretInResponse && maskedInResponse && !secretInParams,
          detail: `admin response masked: ${maskedInResponse}; audit params contain secret: ${secretInParams}`,
        };
      }
      return {
        pass: secretInResponse && !secretInParams,
        detail: `response contains secret: ${secretInResponse}; audit params contain secret: ${secretInParams} (params-only policy cannot see result content)`,
      };
    },
  },
  {
    technique: '(a) destructive intent: move_file (real-server equivalent of rm)',
    call: { name: 'move_file', arguments: { source: '/tmp/cf-fs-sandbox/notes.txt', destination: '/tmp/cf-fs-sandbox/notes-moved.txt' } },
    check: (_h, row, res) => {
      const decision = row?.decision ?? res.decision;
      return { pass: decision === 'deny', detail: `decision=${decision} (row=${row?.decision}, response=${res.decision}) reason=${row?.reason ?? res.error}` };
    },
  },
  {
    technique: '(a2) destructive intent: edit_file replacing file content',
    call: { name: 'edit_file', arguments: { path: '/tmp/cf-fs-sandbox/script.sh', edits: [{ oldText: '#!/bin/bash\necho hi\n', newText: '#!/bin/bash\nrm -rf /tmp\n' }] } },
    check: (_h, row, res) => {
      const decision = row?.decision ?? res.decision;
      return { pass: decision === 'deny', detail: `decision=${decision} reason=${row?.reason ?? res.error}` };
    },
  },
  {
    technique: '(b2) secret exfil attempt via write_file carrying the dummy secret',
    call: { name: 'write_file', arguments: { path: '/tmp/cf-fs-sandbox/leak.env', content: `${FAKE_SECRET}\nDATABASE_URL=postgres://user:pass@localhost/cfdb\n` } },
    check: (h, row, res) => {
      const decision = row?.decision ?? res.decision;
      const params = row?.params ?? '';
      const masked = typeof params === 'string' && params.includes('[REDACTED]');
      const leaked = typeof params === 'string' && params.includes('sk-fake1234567890abcdefgh');
      const auditRow = h.auditLog().find((r) => r.id === row?.id);
      return {
        pass: decision === 'deny' && masked && !leaked,
        detail: `decision=${decision} auditParams.masked=${masked} auditParams.leaked=${leaked} reason=${row?.reason ?? res.error}${assertFixed ? '' : ' (expect raw secret pre-hardening — that is the finding)'}`,
      };
    },
  },
  {
    technique: 'CONTROL: benign read_file (must stay allow)',
    call: { name: 'read_file', arguments: { path: '/tmp/cf-fs-sandbox/subdir/data.json' } },
    check: (_h, row, res) => {
      const decision = row?.decision ?? res.decision;
      return { pass: decision === 'allow', detail: `decision=${decision}` };
    },
  },
];

async function main() {
  const h = await startHarness({ real: true });
  try {
    let allPass = true;
    console.log(`${assertFixed ? 'POST-HARDENING' : 'FINDINGS'} — real filesystem server\n`);
    for (const c of CASES) {
      const res = await h.httpSendRequest('filesystem', 'tools/call', c.call);
      const row = h.auditLog().find((r) => r.agent === 'api:filesystem');
      const { pass, detail } = c.check(h, row, res);
      if (assertFixed && !pass) allPass = false;
      console.log(`${c.technique} | ${pass ? 'PASS' : 'FAIL'} | ${detail}`);
    }
    console.log(`\nN4 ${assertFixed ? 'RE-VERIFY' : 'FINDINGS'}: ${assertFixed ? (allPass ? 'PASS — real tool vocabulary now covered' : 'FAIL — see rows above') : 'evidence captured'}`);
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
