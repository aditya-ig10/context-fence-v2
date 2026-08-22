// N3+N5 dev-mode verification of the Electron shell.
// Test A: fresh CF_USER_DATA → first-run setup window with real progress →
//        dashboard window opens with the live frontend.
// Test B: same CF_USER_DATA again → straight to dashboard (no setup).
import { _electron as electron } from 'playwright';
import { mkdirSync, statSync, readdirSync } from 'fs';
import { execSync } from 'child_process';

const SHOTS = '/var/folders/90/z_5cnf7j6zx_mdw41mxrp5000000gn/T/opencode/shots';
const USER_DATA = '/var/folders/90/z_5cnf7j6zx_mdw41mxrp5000000gn/T/opencode/ctxfence-userdata-n3';
mkdirSync(SHOTS, { recursive: true });

const env = { ...process.env, CF_USER_DATA: USER_DATA };

async function launch(tag) {
  const app = await electron.launch({
    args: ['.'],
    cwd: '/Users/aditya/Documents/GitHub/mcp-firewall/electron',
    executablePath: '/Users/aditya/Documents/GitHub/mcp-firewall/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    env,
  });
  app.process().stdout?.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  app.process().stderr?.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  return app;
}

// ── Test A: first run ──
console.log('--- Test A: first run (fresh userData) ---');
const ORPHAN_PAT = '[t]sx src/index|[m]ock-mcp-server';
const snap = (label) => execSync(`ps -axo pid,command | grep -E "${ORPHAN_PAT}" || true`).toString().trim();
const beforeA = new Set(snap('pre').split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]));
const appA = await launch('A');
const setupWin = await appA.firstWindow();
await setupWin.waitForTimeout(600);
await setupWin.screenshot({ path: `${SHOTS}/gp13-n5-setup-running.png` });
console.log('A setup steps rendered:', await setupWin.locator('.step').count());

const dashPromise = appA.waitForEvent('window', { timeout: 60000 });
const dashWin = await dashPromise;
await dashWin.waitForLoadState('domcontentloaded');
await dashWin.waitForSelector('.stat-card, .fw-hero-subtitle', { timeout: 20000 }).catch(() => null);
await dashWin.waitForTimeout(2500);
console.log('A dashboard url:', dashWin.url());
console.log('A dashboard stat cards:', await dashWin.locator('.stat-card').count());
await dashWin.screenshot({ path: `${SHOTS}/gp13-n3-dashboard-dev.png` });

const health = execSync('curl -s http://localhost:3000/api/health --max-time 3').toString();
console.log('A backend health while app open:', health);

// evidence: userData artifacts
const dataDir = `${USER_DATA}/data`;
console.log('A db file:', statSync(`${dataDir}/context-fence.db`).size, 'bytes');
console.log('A policy file:', statSync(`${USER_DATA}/context-fence.yaml`).size, 'bytes');
const det = execSync('curl -s http://localhost:3000/api/detect --max-time 3').toString();
console.log('A /api/detect:', det.slice(0, 300));

await appA.close();
await new Promise((r) => setTimeout(r, 6000));
const afterA = new Set(snap('post').split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]));
const orphans = [...afterA].filter((p) => !beforeA.has(p));
console.log('A orphan processes after quit (pid diff):', orphans.length ? orphans.join(',') : 'NONE');
console.log('A port 3000 after quit:', execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health --max-time 2 || echo down').toString());

// ── Test B: second launch, same userData ──
console.log('--- Test B: second run (existing userData) ---');
const appB = await launch('B');
const winB = await appB.firstWindow();
await winB.waitForTimeout(5000);
console.log('B first window url:', winB.url());
console.log('B setup steps present (0 expected):', await winB.locator('.step').count());
const isDash = winB.url().includes('localhost:5173');
console.log('B PASS: straight to dashboard =', isDash);
await winB.screenshot({ path: `${SHOTS}/gp13-n5-second-run-dashboard.png` });
await appB.close();
