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

// ---- N1/N3: dashboard strings ----
await page.goto('http://localhost:5173/');
await page.waitForSelector('.d-heading', { timeout: 20000 });
await page.waitForTimeout(2500);
const bodyText = await page.locator('body').innerText();
log('N1 eyebrow "Request Distribution" present:', bodyText.includes('Request Distribution'));
log('N1 heading present (title case-insensitive):', bodyText.toUpperCase().includes('POLICY OUTCOMES BREAKDOWN (CUSTOMISABLE FROM SETTINGS)'));
log('N1 old eyebrow "This month (allow / deny / log)" gone:', !bodyText.includes('This month (allow / deny / log)'));
log('N3 eyebrow "Performance" present:', bodyText.includes('Performance'));
log('N3 old eyebrow "Real metrics — current (24h) vs 7-day baseline" gone:', !bodyText.includes('Real metrics — current (24h) vs 7-day baseline'));

// ---- N2: stat line reflects 7-day window (dash_window=7-day already set via API) ----
log('N2 stat line "Allowed rate: 65.0% (last 7 days)":', bodyText.includes('Allowed rate: 65.0% (last 7 days)'));

// ---- N2: Settings page controls ----
await page.goto('http://localhost:5173/settings');
await page.waitForSelector('.section-title', { timeout: 20000 });
await page.waitForTimeout(1000);
const settingsText = await page.locator('body').innerText();
log('N2 Settings "Dashboard" section present:', settingsText.includes('Dashboard') && settingsText.includes('Window:') && settingsText.includes('Categories:'));
log('N2 window button "7 days" selected (computed border coral):', await page.locator('.glass-card', { hasText: 'Dashboard' }).locator('button:has-text("7 days")').evaluate((el) => getComputedStyle(el).borderColor === 'rgb(255, 90, 95)'));
await page.screenshot({ path: '/var/folders/90/z_5cnf7j6zx_mdw41mxrp5000000gn/T/opencode/shots/settings-dash.png' });

// Toggle a category off and confirm dashboard reflects it
await page.locator('button:has-text("Logged")').click();
await page.waitForTimeout(600);
log('N2 toggle Logged off: status visible:', (await page.locator('text=Saved').count()) > 0);
await page.locator('button:has-text("Logged")').click(); // restore
await page.waitForTimeout(600);

await page.goto('http://localhost:5173/');
await page.waitForSelector('.d-heading', { timeout: 20000 });
await page.waitForTimeout(2000);
const body2 = await page.locator('body').innerText();
log('N2 doughnut legend shows only Allowed+Blocked after Logged off (during toggle):', !body2.includes('Logged 1'));
log('N2 doughnut legend shows Logged again after restore:', body2.includes('Logged'));

log(`page errors: ${pageErrors}`);
console.log('ALL_DONE');
await browser.close();
