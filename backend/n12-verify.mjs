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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route('**/src/lib/firebase.ts', (r) => r.fulfill({ body: MOCK_FIREBASE, contentType: 'application/javascript' }));
await ctx.addInitScript(() => {
  localStorage.setItem('cf_mock_user', '1');
  localStorage.setItem('cf_has_session', 'true');
  localStorage.setItem('cf_onboarding_seen', 'true');
});
let errs = 0;
ctx.on('pageerror', () => errs++);
ctx.on('response', (r) => {
  if (r.url().includes('/api/') && r.request().frame().page() === pageB) console.log('TAB-B API RESP:', r.request().method(), r.url().split('/api/')[1], r.status());
});

const pageB = await ctx.newPage(); // viewer tab — holds cached data
const pageA = await ctx.newPage(); // editor tab

// ---------- A) Policies: edit in tab A, measure reflect time in tab B ----------
const REASON = `N12-TWOTAB-${Date.now()}`;
await pageB.goto('http://localhost:5173/policies');
await pageB.waitForSelector('.data-table tbody tr');
await pageB.waitForFunction(() => document.body.innerText.includes('block-destructive'), null, { timeout: 8000 });
const seenBefore = await pageB.evaluate((r) => document.body.innerText.includes(r), REASON);

await pageA.goto('http://localhost:5173/policies');
await pageA.waitForSelector('.data-table tbody tr');
console.log('A edit btn:', await pageA.locator('tr', { hasText: 'block-destructive' }).first().locator('button[title*="Edit"]').count());
await pageA.locator('tr', { hasText: 'block-destructive' }).first().locator('button[title*="Edit"]').click();
await pageA.waitForTimeout(400);
console.log('A inputs:', await pageA.locator('input[placeholder="Reason shown when triggered"]').count());
await pageA.fill('input[placeholder="Reason shown when triggered"]', REASON);
console.log('A save btns:', await pageA.locator('button:has-text("Save")').count());
await pageA.locator('button:has-text("Save")').click();
await pageA.waitForTimeout(1500);
console.log('A row after save:', (await pageA.locator('tr', { hasText: 'block-destructive' }).first().innerText()).slice(0, 100).replace(/\n/g, ' | '));
const t0 = Date.now();
await pageB.bringToFront();

let policyReflect = null;
try {
  await pageB.waitForFunction((r) => document.body.innerText.includes(r), REASON, { timeout: 25000, polling: 1000 });
  policyReflect = Date.now() - t0;
} catch { policyReflect = 'never (>25s) FAIL'; }

await pageA.locator('tr', { hasText: 'block-destructive' }).first().locator('button[title="Restore default"]').click();
await pageA.waitForTimeout(800);

// ---------- B) AuditLog: deny in tab A, measure reflect time in tab B ----------
await pageB.goto('http://localhost:5173/logs');
await pageB.waitForSelector('.data-table tbody tr');
const firstTsBefore = await pageB.evaluate(() => document.querySelector('.data-table tbody tr td')?.textContent.trim() || '');

const t1 = Date.now();
await pageA.bringToFront();
await pageA.evaluate(async () => {
  await fetch('/api/test-mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'mock-mcp', method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'rm -rf /tmp/n12-probe' } } }),
  });
});

await pageB.bringToFront();
let auditReflect = null;
try {
  await pageB.waitForFunction((prev) => {
    const td = document.querySelector('.data-table tbody tr td')?.textContent?.trim() || '';
    return td !== prev && td !== '';
  }, firstTsBefore, { timeout: 25000, polling: 1000 });
  auditReflect = Date.now() - t1;
} catch { auditReflect = 'never (>25s) FAIL'; }

console.log('policies: tabB saw new reason before edit?', seenBefore);
console.log(`POLICIES two-tab time-to-reflect: ${policyReflect}ms (maxAge 15s)`);
console.log(`AUDITLOG two-tab time-to-reflect: ${auditReflect}ms (maxAge 15s)`);
console.log(`page errors: ${errs}`);
console.log('ALL_DONE');
await browser.close();
