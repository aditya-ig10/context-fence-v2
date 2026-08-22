// N8: clean-machine test of the PACKAGED app (release build).
// Fresh CF_USER_DATA, no dev backend, no dev frontend.
// Verifies: first-run setup → dashboard → real agents, backend lifecycle
// (health while open, zero orphans after quit), packaged artifacts.
import { _electron as electron } from 'playwright';
import { mkdirSync, statSync } from 'fs';
import { execSync } from 'child_process';

const SHOTS = '/var/folders/90/z_5cnf7j6zx_mdw41mxrp5000000gn/T/opencode/shots';
const USER_DATA = '/var/folders/90/z_5cnf7j6zx_mdw41mxrp5000000gn/T/opencode/ctxfence-userdata-n8';
mkdirSync(SHOTS, { recursive: true });
execSync(`rm -rf ${USER_DATA}`);
mkdirSync(USER_DATA, { recursive: true });

const APP = '/Users/aditya/Documents/GitHub/mcp-firewall/electron/release/mac-arm64/Context Fence.app/Contents/MacOS/Context Fence';
const PAT = '[t]sx src/index|[m]ock-mcp-server|[b]ackend/dist/index.js';
const snap = () => execSync(`ps -axo pid,command | grep -E "${PAT}" || true`).toString().trim();
const before = new Set(snap().split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]));

console.log('--- N8: packaged app, fresh userData ---');
console.log('pre-flight stray matches:', before.size);

const app = await electron.launch({ executablePath: APP, args: [], env: { ...process.env, CF_USER_DATA: USER_DATA } });
let backendLog = '';
app.process().stdout?.on('data', (d) => { backendLog += d; });
app.process().stderr?.on('data', (d) => { backendLog += d; });

const win = await app.firstWindow();
await win.waitForTimeout(900);
console.log('N8 window title:', await win.title());
const steps = await win.locator('.step').all();
for (const s of steps) {
  console.log('N8 step:', (await s.textContent()).trim().replace(/\s+/g, ' ').slice(0, 80));
}
await win.screenshot({ path: `${SHOTS}/gp13-n8-setup.png` });

let dash = null;
try {
  dash = await app.waitForEvent('window', { timeout: 90000 });
} catch (e) {
  console.log('N8 FAIL: no dashboard window. app stdout/stderr so far:');
  console.log(backendLog.split('\n').slice(-40).join('\n'));
  throw e;
}
await dash.waitForTimeout(3500);
console.log('N8 dashboard url:', dash.url());
await dash.screenshot({ path: `${SHOTS}/gp13-n8-dashboard.png` });

const m = backendLog.match(/backend running on http:\/\/localhost:(\d+)/);
const port = m ? m[1] : '?';
console.log('N8 packaged backend port:', port);
console.log('N8 health while open:', execSync(`curl -s http://localhost:${port}/api/health --max-time 3`).toString().slice(0, 60));

const det = execSync(`curl -s http://localhost:${port}/api/detect --max-time 5`).toString();
console.log('N8 /api/detect agents:', (JSON.parse(det).agents || []).map((a) => a.name).join(', '));

console.log('N8 db file:', statSync(`${USER_DATA}/data/context-fence.db`).size, 'bytes');
console.log('N8 policy file:', statSync(`${USER_DATA}/context-fence.yaml`).size, 'bytes');

const during = execSync(`ps -axo command | grep -E "[b]ackend/dist/index.js" || true`).toString().trim();
console.log('N8 packaged backend process (during):', during ? 'running' : 'MISSING');

execSync('sleep 2');
execSync(`screencapture -x ${SHOTS}/gp13-n8-dock.png`);

await app.close();
await new Promise((r) => setTimeout(r, 12000));
const after = new Set(snap().split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]));
const orphans = [...after].filter((p) => !before.has(p));
console.log('N8 orphan processes after quit (pid diff):', orphans.length ? orphans.join(',') : 'NONE');
console.log('N8 done');
