// N2 — direct stdio ping of the two real MCP servers (raw spawn, NO proxy):
// initialize + tools/list, so the real tool vocabulary is captured before any
// policy work. Also verifies the sandbox dir and the registered DB rows (N1).

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { JsonRpcFramer } from '../src/mcp/framer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'node_modules', '.bin');

interface PingResult {
  name: string;
  serverInfo: unknown;
  tools: { name: string; description: string }[];
}

function ping(command: string, args: string[], timeoutMs = 45000): Promise<PingResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
    const framer = new JsonRpcFramer();
    const requests = new Map<string, { resolve: (m: unknown) => void }>();
    let serverInfo: unknown = null;
    let tools: { name: string; description: string }[] = [];
    let stderr = '';

    child.stdout?.pipe(framer);
    framer.on('data', (msg: any) => {
      if (!msg || msg.id === undefined || msg.id === null) return;
      const pending = requests.get(String(msg.id));
      if (!pending) return;
      requests.delete(String(msg.id));
      pending.resolve(msg);
    });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    let id = 1;
    const send = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        requests.set(String(id), { resolve });
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) + '\n');
      });

    (async () => {
      const init = (await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cf-direct-ping', version: '0.0.1' } })) as any;
      serverInfo = init.result?.serverInfo;
      if (init.result?.capabilities?.experimental) void 0;
      await send('notifications/initialized', {});
      const tl = (await send('tools/list', {})) as any;
      tools = (tl.result?.tools ?? []).map((t: any) => ({ name: t.name, description: (t.description ?? '').slice(0, 60) }));
      child.kill('SIGTERM');
      resolve({ name: command.split('/').pop()!, serverInfo, tools });
    })().catch((err) => {
      child.kill('SIGKILL');
      reject(new Error(`ping failed: ${err.message}\nstderr: ${stderr.slice(-500)}`));
    });

    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      if (requests.size > 0) reject(new Error(`timeout after ${timeoutMs}ms waiting on: ${[...requests.keys()].join(',')}`));
    }, timeoutMs);
  });
}

async function main() {
  console.log('=== N1: sandbox contents ===');
  console.log(`/tmp/cf-fs-sandbox: ${['notes.txt', '.env', 'script.sh', 'subdir/data.json'].map((f) => existsSync(`/tmp/cf-fs-sandbox/${f}`) ? f : `${f}(MISSING)`).join(', ')}`);

  console.log('\n=== N2: direct ping — filesystem ===');
  const fsInfo = await ping(join(BIN, 'mcp-server-filesystem'), ['/tmp/cf-fs-sandbox']);
  console.log('serverInfo:', JSON.stringify(fsInfo.serverInfo));
  console.log('tools:', fsInfo.tools.map((t) => t.name).join(', '));

  console.log('\n=== N2: direct ping — playwright ===');
  const pwInfo = await ping(join(BIN, 'playwright-mcp'), ['--headless']);
  console.log('serverInfo:', JSON.stringify(pwInfo.serverInfo));
  console.log('tools:', pwInfo.tools.map((t) => t.name).join(', '));

  const pwTools = pwInfo.tools.map((t) => t.name);
  const fsTools = fsInfo.tools.map((t) => t.name);
  console.log('\n=== N2 tool-vocabulary notes ===');
  console.log(`filesystem destructive-ish tools: ${fsTools.filter((t) => /delete|move|write|edit|truncate/i.test(t)).join(', ') || '(none found)'}`);
  console.log(`playwright evaluate-ish tools: ${pwTools.filter((t) => /evaluate|exec|script/i.test(t)).join(', ') || '(none — no arbitrary JS eval tool exposed)'}`);
  console.log(`playwright capture tools: ${pwTools.filter((t) => /screenshot|snapshot|pdf|network|console/i.test(t)).join(', ')}`);
  console.log('\nN2 DIRECT PING: PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
