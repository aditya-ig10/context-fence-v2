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
page.setDefaultTimeout(15000);
const log = (...ms) => console.log(...ms);

await page.route('**/src/lib/firebase.ts', (r) => r.fulfill({ body: MOCK_FIREBASE, contentType: 'application/javascript' }));
await page.addInitScript(() => {
  localStorage.setItem('cf_mock_user', '1');
  localStorage.setItem('cf_has_session', 'true');
  localStorage.setItem('cf_onboarding_seen', 'true');
});
let pageErrors = 0;
page.on('pageerror', () => pageErrors++);

await page.goto('http://localhost:5173/policies');
await page.waitForSelector('.section-title', { timeout: 20000 });
await page.waitForTimeout(1200);

const row = page.locator('tr', { hasText: 'block-destructive' }).first();
const originBefore = (await row.locator('td').nth(2).innerText()).trim();
const editBtnsBefore = await row.locator('button[title*="Edit"]').count();
log('before: origin badge =', JSON.stringify(originBefore), '| edit buttons on row =', editBtnsBefore);

// (a) Edit the built-in rule's reason via the GUI
await row.locator('button[title*="Edit"]').click();
await page.waitForTimeout(500);
await page.fill('input[placeholder="Reason shown when triggered"]', 'GUI-EDITED: destructive shell commands are blocked');
await page.locator('button:has-text("Save")').click();
await page.waitForTimeout(1200);

const rowAfter = page.locator('tr', { hasText: 'block-destructive' }).first();
const originAfter = (await rowAfter.locator('td').nth(2).innerText()).trim();
const restoreBtns = await rowAfter.locator('button[title="Restore default"]').count();
log('(a) after GUI edit: origin badge =', JSON.stringify(originAfter), '| restore buttons =', restoreBtns);
const reasonShown = (await rowAfter.innerText()).includes('GUI-EDITED');
log('(a) new reason visible in row:', reasonShown);

// (b) real proxied request → new reason in audit_log (backend already proven; re-check live)
const api = await page.evaluate(async () => {
  const r = await fetch('/api/test-mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'mock-mcp', method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'rm -rf /tmp/evil' } } }),
  });
  return r.json();
});
log('(b) proxied decision/error:', JSON.stringify({ ok: api.ok, error: api.result?.error }));
log('(b) new reason in proxied response:', JSON.stringify(api.result?.error).includes('GUI-EDITED'));

// (c) Restore default via the GUI
await rowAfter.locator('button[title="Restore default"]').click();
await page.waitForTimeout(1200);
const rowRestored = page.locator('tr', { hasText: 'block-destructive' }).first();
const originRestored = (await rowRestored.locator('td').nth(2).innerText()).trim();
const restoreAfter = await rowRestored.locator('button[title="Restore default"]').count();
log('(c) after restore: origin badge =', JSON.stringify(originRestored), '| restore buttons =', restoreAfter);

const api2 = await page.evaluate(async () => {
  const r = await fetch('/api/test-mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'mock-mcp', method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'rm -rf /tmp/evil' } } }),
  });
  return r.json();
});
log('(c) original reason back in proxied response:', JSON.stringify(api2.result?.error) === '"Request blocked by Context Fence: Destructive command blocked"');

log(`page errors: ${pageErrors}`);
console.log('ALL_DONE');
await browser.close();
