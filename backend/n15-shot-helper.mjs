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

const [route, theme, out] = process.argv.slice(2);
if (!route || !theme || !out) { console.error('usage: node shot.mjs <route> <light|dark|system> <out.png>'); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
let pageErrors = 0;
page.on('pageerror', () => pageErrors++);
await page.route('**/src/lib/firebase.ts', (r) => r.fulfill({ body: MOCK_FIREBASE, contentType: 'application/javascript' }));
await page.addInitScript(() => {
  localStorage.setItem('cf_mock_user', '1');
  localStorage.setItem('cf_has_session', 'true');
  localStorage.setItem('cf_onboarding_seen', 'true');
});
await page.goto(`http://localhost:5173${route}`);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1500);
if (theme === 'dark') await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
else if (theme === 'light') await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
else await page.evaluate(() => { delete document.documentElement.dataset.theme; });
await page.waitForTimeout(800);
await page.screenshot({ path: out, fullPage: true });
console.log(`shot: ${out} pageErrors=${pageErrors}`);
await browser.close();
