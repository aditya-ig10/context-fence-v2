import { chromium } from 'playwright';

const MOCK_FIREBASE = `export const hasFirebaseConfig = false;
export const auth = null; export const db = null;
export const logout = async () => {}; export const fetchUserProfile = async () => null;
export const saveUserProfile = async () => {}; export const resetPassword = async () => {};
export const loginWithGooglePopup = async () => { throw new Error('mock'); };
export const getFirebaseErrorMessage = (e) => String(e);
export const loginWithGoogle = async () => { throw new Error('mock'); };
export const loginWithApple = async () => { throw new Error('mock'); };
export const loginWithApplePopup = async () => { throw new Error('mock'); };
export const loginWithEmail = async () => { throw new Error('mock'); };
export const registerWithEmail = async () => { throw new Error('mock'); };
export const loginWithGoogleSystem = async () => { throw new Error('mock'); };
export const loginWithAppleSystem = async () => { throw new Error('mock'); };
export const saveGoogleUserProfile = async () => {};
export const googleProvider = null; export const appleProvider = null;
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const log = (...ms) => console.log(...ms);

await page.route('**/src/lib/firebase.ts', (r) => r.fulfill({ body: MOCK_FIREBASE, contentType: 'application/javascript' }));
await page.addInitScript(() => {
  localStorage.setItem('cf_mock_user', '1');
  localStorage.setItem('cf_has_session', 'true');
  localStorage.setItem('cf_onboarding_seen', 'true');
});
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text().slice(0, 200)); });

const apiCounts = new Map();
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith('/api/')) apiCounts.set(u.pathname, (apiCounts.get(u.pathname) || 0) + 1);
});

const side = (label) => page.locator('.sidebar-link', { hasText: label });
async function nav(label) { await side(label).click(); }

// ---------- Phase A: populate the cache by visiting every page once ----------
log('== Phase A: first pass (populates cache) ==');
await page.goto('http://localhost:5173/');
await page.waitForSelector('.d-metric-value');
await page.waitForFunction(() => document.querySelector('.d-metric-value')?.textContent !== '—', null, { timeout: 8000 });
await nav('Policies');
await page.waitForFunction(() => document.querySelectorAll('.data-table tbody tr').length > 0, null, { timeout: 8000 });
await nav('Audit Log');
await page.waitForFunction(() => document.querySelectorAll('.data-table tbody tr').length > 0, null, { timeout: 8000 });
await nav('Test MCP');
await page.waitForFunction(() => document.querySelectorAll('.tm-server-card').length > 0, null, { timeout: 8000 });
await nav('Settings');
await page.waitForFunction(() => document.body.innerText.toUpperCase().includes('API AGENT REGISTRATION'), null, { timeout: 8000 });
await nav('Agents');
await page.waitForFunction(() => document.querySelectorAll('.ag-card').length > 0, null, { timeout: 8000 });
const firstAgentCard = page.locator('.ag-card').first();
if (await firstAgentCard.count()) {
  await firstAgentCard.click();
  await page.waitForFunction(() => document.body.innerText.toUpperCase().includes('INSTALLED') || document.body.innerText.toUpperCase().includes('FIRST SEEN'), null, { timeout: 8000 });
}
const afterA = new Map(apiCounts);
log('phase A page-level api hits:', JSON.stringify(Object.fromEntries([...afterA].filter(([k]) => ['/api/stats','/api/policies','/api/policies/status','/api/logs','/api/settings','/api/agents','/api/health','/api/servers','/api/detect'].includes(k)))));

// ---------- Phase B: revisit — instant data, zero network ----------
log('== Phase B: revisit cycle (no flash, no network) ==');
const beforeB = new Map(apiCounts);
const checks = [];
async function revisitCheck(label2, hasDataFn, assertFn) {
  await nav(label2);
  await page.waitForTimeout(45); // sample right after first commit
  const ok = await page.evaluate(assertFn);
  const flash = !ok;
  checks.push(`${label2}: ${flash ? 'FLASH/EMPTY' : 'instant'}`);
  await page.waitForFunction(hasDataFn, null, { timeout: 8000 });
}
await revisitCheck('Dashboard',
  () => document.querySelector('.d-metric-value')?.textContent !== '—',
  () => { const t = document.querySelector('.d-metric-value')?.textContent; return !!t && t !== '—'; });
await revisitCheck('Policies',
  () => document.querySelectorAll('.data-table tbody tr').length > 0,
  () => document.querySelectorAll('.data-table tbody tr').length > 0);
await revisitCheck('Audit Log',
  () => document.querySelectorAll('.data-table tbody tr').length > 0,
  () => document.querySelectorAll('.data-table tbody tr').length > 0);
await revisitCheck('Test MCP',
  () => document.querySelectorAll('.tm-server-card').length > 0,
  () => document.querySelectorAll('.tm-server-card').length > 0);
await revisitCheck('Settings',
  () => document.body.innerText.toUpperCase().includes('API AGENT REGISTRATION'),
  () => document.body.innerText.toUpperCase().includes('API AGENT REGISTRATION'));
await revisitCheck('Agents',
  () => document.querySelectorAll('.ag-card').length > 0,
  () => document.querySelectorAll('.ag-card').length > 0);
if (await page.locator('.ag-card').first().count()) {
  await nav('Agents');
  await page.waitForSelector('.ag-card');
  await page.locator('.ag-card').first().click();
  await page.waitForTimeout(45);
  const ok = await page.evaluate(() => document.body.innerText.toUpperCase().includes('INSTALLED') || document.body.innerText.toUpperCase().includes('FIRST SEEN'));
  checks.push(`AgentDetail: ${ok ? 'instant' : 'FLASH/EMPTY'}`);
  await page.waitForFunction(() => document.body.innerText.toUpperCase().includes('INSTALLED') || document.body.innerText.toUpperCase().includes('FIRST SEEN'), null, { timeout: 8000 });
}
const afterB = new Map(apiCounts);
const refetched = [];
for (const k of ['/api/stats','/api/policies','/api/policies/status','/api/logs','/api/settings','/api/agents','/api/health','/api/servers','/api/detect']) {
  const delta = (afterB.get(k) || 0) - (beforeB.get(k) || 0);
  if (delta > 0) refetched.push(`${k}(${delta})`);
}
log('revisit no-flash checks:', checks.join(' | '));
log('network refetched on revisit:', refetched.length ? refetched.join(', ') : 'NONE — all served from cache');

// ---------- Phase C: mutation reflects immediately ----------
log('== Phase C: mutations invalidate cache + reflect immediately ==');
await nav('Policies');
await page.waitForSelector('.data-table tbody tr');
await page.locator('tr', { hasText: 'block-destructive' }).first().locator('button[title*="Edit"]').click();
await page.waitForTimeout(400);
await page.fill('input[placeholder="Reason shown when triggered"]', 'N11-CACHE: reason changed');
await page.locator('button:has-text("Save")').click();
const tEdit = Date.now();
try {
  await page.waitForFunction(() => document.body.innerText.includes('N11-CACHE: reason changed'), null, { timeout: 5000 });
} catch (e) {
  console.log('phaseC-save FAILED. db state check via API:');
  const dbg = await page.evaluate(async () => (await fetch('/api/policies')).json());
  console.log('api block-destructive:', JSON.stringify(dbg.rules?.find(r => r.name === 'block-destructive')));
  console.log('body snippet:', (await page.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\n/g, ' | '));
  throw e;
}
log(`Policies GUI edit visible after: ${Date.now() - tEdit}ms`);
await page.locator('tr', { hasText: 'block-destructive' }).first().locator('button[title="Restore default"]').click();
await page.waitForFunction(() => !document.body.innerText.includes('N11-CACHE: reason changed'), null, { timeout: 5000 });
log('Policies restore reverted immediately: yes');

await nav('Settings');
await page.waitForSelector('.section-title');
await page.locator('button:has-text("Dark")').first().click().catch(() => {});
await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 4000 });
log('Settings theme toggle reflected immediately: yes');

await nav('Test MCP');
await page.waitForSelector('.tm-server-card');
const probeServer = `cache-probe-${Date.now()}`;
const created = await page.evaluate(async (probeServer) => {
  const r = await fetch('/api/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: probeServer, type: 'http', url: 'http://localhost:19999' }) });
  return r.ok;
}, probeServer);
log('created probe server:', created);
await page.locator('button[title="Refresh status"]').click();
const tRefresh = Date.now();
await page.waitForFunction((p) => document.body.innerText.includes(p), probeServer, { timeout: 6000 });
log(`TestMCP refresh shows new server after: ${Date.now() - tRefresh}ms`);

// ---------- Phase D: background revalidation after staleness (Policies, 15s) ----------
log('== Phase D: background revalidation after 15s staleness ==');
await nav('Policies');
await page.waitForSelector('.data-table tbody tr');
const probePolicy = `cache-stale-probe-${Date.now()}`;
const t0 = Date.now();
await page.evaluate(async (probePolicy) => {
  await fetch('/api/policies/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: probePolicy, description: 'staleness probe', action: 'allow', reason: 'probe', methods: '', tools: 'nonexistent_tool_xyz', param_contains: '' }) });
}, probePolicy);
let appearedMs = null;
try {
  await page.waitForFunction((p) => document.body.innerText.includes(p), probePolicy, { timeout: 20000 });
  appearedMs = Date.now() - t0;
} catch { appearedMs = 'never (FAIL)'; }
log(`stale policy appeared without interaction after: ${appearedMs}ms (maxAge=15s)`);
await page.evaluate(async (p) => { await fetch(`/api/policies/${p}`, { method: 'DELETE' }); }, probePolicy);

log(`page errors: ${pageErrors}`);
console.log('ALL_DONE');
await browser.close();
