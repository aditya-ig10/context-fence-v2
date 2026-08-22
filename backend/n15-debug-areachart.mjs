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
await page.waitForTimeout(2500);

const curves = await page.locator('.recharts-area-curve').count();
const bars = await page.locator('.recharts-bar-rectangle').count();
console.log('area curves:', curves, '| bar rectangles:', bars);

const card = await page.locator('.chart-card', { hasText: 'Calls Over Time' });
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
const box = await card.boundingBox();
const readTooltip = async () => {
  const n = await page.locator('.chart-tooltip').count();
  if (!n) return '';
  return ((await page.locator('.chart-tooltip').first().innerText()) || '').replace(/\n/g, ' | ');
};
for (const f of [0.22, 0.62, 0.83]) {
  await page.mouse.move(box.x + box.width * f, box.y + box.height * 0.55);
  await page.waitForTimeout(150);
  const tt = await readTooltip();
  if (tt) console.log('hover', f, '->', tt);
}
console.log('PAGE_ERRORS', pageErrors);
await browser.close();
