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

await page.route('**/src/lib/firebase.ts', (r) => r.fulfill({ body: MOCK_FIREBASE, contentType: 'application/javascript' }));
await page.addInitScript(() => {
  localStorage.setItem('cf_mock_user', '1');
  localStorage.setItem('cf_has_session', 'true');
  localStorage.setItem('cf_onboarding_seen', 'true');
});
let pageErrors = 0;
page.on('pageerror', () => pageErrors++);

async function grab(route, tableSel, thSel, tdSel) {
  await page.goto(route);
  await page.waitForSelector('.data-table th', { timeout: 20000 });
  await page.waitForTimeout(900);
  const pick = (el) => {
    const s = getComputedStyle(el);
    const r = {};
    ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'fontSize', 'fontWeight', 'textTransform', 'letterSpacing', 'color', 'background', 'borderBottomColor'].forEach((k) => r[k] = s[k]);
    return r;
  };
  const th = await page.locator(`${tableSel} .data-table th`).first().evaluate(pick);
  const td = await page.locator(`${tableSel} .data-table tbody td`).first().evaluate(pick);
  const card = await page.locator(tableSel).evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.background, borderRadius: s.borderRadius, overflow: s.overflow, boxShadow: s.boxShadow };
  });
  const tr = page.locator(`${tableSel} .data-table tbody tr`).first();
  await tr.hover();
  await page.waitForTimeout(350);
  const hoverBg = await tr.evaluate((el) => getComputedStyle(el).background);
  return { th, td, card, hoverBg };
}

const pol = await grab('http://localhost:5173/policies', '.data-table-card', 'th', 'td');
const aud = await grab('http://localhost:5173/logs', '.data-table-card', 'th', 'td');

const keys = Object.keys(pol.th);
let allSame = true;
for (const k of keys) {
  const same = pol.th[k] === aud.th[k] && pol.td[k] === aud.td[k];
  if (!same) allSame = false;
  console.log(`${k.padEnd(18)} th ${pol.th[k]} === ${aud.th[k]} ${pol.th[k] === aud.th[k] ? 'OK' : 'DIFF'} | td ${pol.td[k]} === ${aud.td[k]} ${pol.td[k] === aud.td[k] ? 'OK' : 'DIFF'}`);
}
console.log('card styles equal:', JSON.stringify(pol.card) === JSON.stringify(aud.card), JSON.stringify(pol.card));
console.log('hover bg equal:', pol.hoverBg === aud.hoverBg, pol.hoverBg);
console.log(`computed-style diff: ${allSame ? 'IDENTICAL' : 'MISMATCH'}`);
console.log(`page errors: ${pageErrors}`);
console.log('ALL_DONE');
await browser.close();
