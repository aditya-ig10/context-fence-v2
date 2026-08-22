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

const reqs = [];
page.on('request', (r) => { if (r.url().includes('/api/')) reqs.push(r.url()); });

await page.goto('http://localhost:5173/');
await page.waitForSelector('.chart-card', { timeout: 20000 });
await page.waitForTimeout(2000);

await page.evaluate(async () => {
  await fetch('/api/settings/dash_window', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: '7-day' }) });
});

await page.reload();
await page.waitForSelector('.chart-card', { timeout: 20000 });
for (const w of [1000, 3000, 6000]) {
  await page.waitForTimeout(w);
  const stat = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.chart-card')];
    const c = cards.find((x) => x.innerText.includes('Allowed rate:'));
    return c ? c.innerText.split('\n').filter((l) => l.includes('Allowed rate:') || l.includes('% vs')) : null;
  });
  console.log(`after ${w}ms:`, JSON.stringify(stat));
}

console.log('REQUESTS:', reqs.filter((u) => u.includes('outcomes')).join('\n'));
console.log('PAGE_ERRORS', pageErrors);
await browser.close();
