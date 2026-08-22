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
page.setDefaultTimeout(25000);
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR', e.message); });
await page.route('**/src/lib/firebase.ts', (r) => r.fulfill({ body: MOCK_FIREBASE, contentType: 'application/javascript' }));
await page.addInitScript(() => {
  localStorage.setItem('cf_mock_user', '1');
  localStorage.setItem('cf_has_session', 'true');
  localStorage.setItem('cf_onboarding_seen', 'true');
});

await page.goto('http://localhost:5173/');
await page.waitForSelector('.chart-card', { timeout: 20000 });
await page.waitForTimeout(3000);
await page.locator('.chart-card', { hasText: 'Performance' }).scrollIntoViewIfNeeded();
await page.waitForTimeout(500);

const geom = await page.evaluate(() => {
  const ticks = [...document.querySelectorAll('.recharts-polar-angle-axis-tick-value')].map((t) => {
    const r = t.getBoundingClientRect();
    return { label: t.textContent, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  const xs = ticks.map((t) => t.x), ys = ticks.map((t) => t.y);
  return {
    ticks,
    center: { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) },
  };
});
console.log('TICKS', JSON.stringify(geom.ticks), 'CENTER', JSON.stringify(geom.center));

const readTooltip = async () => {
  const n = await page.locator('.chart-tooltip').count();
  if (!n) return '';
  return ((await page.locator('.chart-tooltip').first().innerText()) || '').replace(/\n/g, ' | ');
};

const found = new Map();
for (const t of geom.ticks) {
  for (const f of [0.3, 0.5, 0.75, 0.95]) {
    const x = Math.round(geom.center.x + (t.x - geom.center.x) * f);
    const y = Math.round(geom.center.y + (t.y - geom.center.y) * f);
    await page.mouse.move(x, y);
    await page.waitForTimeout(150);
    const tt = await readTooltip();
    if (tt) found.set(t.label, tt);
  }
}
console.log('FOUND');
for (const [k, v] of found) console.log(`  ${k}: ${v}`);
console.log('PAGE_ERRORS', pageErrors);
await browser.close();
