import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const SHOTS = '/var/folders/90/z_5cnf7j6zx_mdw41mxrp5000000gn/T/opencode/shots';
mkdirSync(SHOTS, { recursive: true });

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
  localStorage.setItem('fw_enabled', 'true');
});

await page.goto('http://localhost:5173/firewall');
await page.waitForSelector('.fw-shield', { timeout: 20000 });
await page.waitForTimeout(3000);

const readShield = () => page.evaluate(() => {
  const s = document.querySelector('.fw-shield');
  const i = document.querySelector('.fw-shield-icon svg');
  const cs = getComputedStyle(s);
  const zone = document.querySelector('.fw-shield-zone');
  const zr = zone.getBoundingClientRect();
  const shield = s.getBoundingClientRect();
  const caption = document.querySelector('.fw-shield-caption');
  const cr = caption.getBoundingClientRect();
  return {
    transform: cs.transform,
    boxShadow: cs.boxShadow,
    opacity: cs.opacity,
    color: getComputedStyle(i).color,
    iconSize: i.getBoundingClientRect().width,
    zoneH: Math.round(zr.height),
    zoneBg: getComputedStyle(zone).backgroundColor,
    zoneBorder: getComputedStyle(zone).borderColor,
    shieldH: Math.round(shield.height),
    captionBelowIcon: cr.top >= shield.bottom,
    hasBgLayer: !!document.querySelector('.fw-visual-bg'),
    hasPattern: !!document.querySelector('.pattern-grid'),
    caption: caption.textContent,
  };
});

const f1 = await readShield();
await page.waitForTimeout(1400);
const f2 = await readShield();
console.log('ENABLED frame1:', JSON.stringify(f1));
console.log('ENABLED frame2:', JSON.stringify(f2));
console.log('N2 animation phase differs (scale/glow moving):', f1.transform !== f2.transform || f1.boxShadow !== f2.boxShadow);
console.log('N2 glow present (coral shadow, not none):', f1.boxShadow !== 'none' && f1.boxShadow.includes('255, 90, 95'));
console.log('N3 zone height = 170px:', f1.zoneH);
console.log('N3 no container behind icon (transparent zone, no bg layer, no pattern):', f1.zoneBg === 'rgba(0, 0, 0, 0)' && !f1.hasBgLayer && !f1.hasPattern);
console.log('N3 caption sits below icon:', f1.captionBelowIcon, '| caption:', f1.caption);

await page.screenshot({ path: `${SHOTS}/gp11-hero-enabled.png`, fullPage: false });

// The shield animates continuously (breathing), so Playwright's actionability
// check never sees it "stable" — force the click like a real user would.
await page.locator('.fw-shield').click({ force: true });
await page.waitForTimeout(600);
const off1 = await readShield();
await page.waitForTimeout(1600);
const off2 = await readShield();
console.log('DISABLED frame1:', JSON.stringify(off1));
console.log('DISABLED frame2:', JSON.stringify(off2));
console.log('N2 disabled static (no animation):', off1.transform === off2.transform && off1.boxShadow === off2.boxShadow);
console.log('N2 disabled muted (opacity < 1, muted color):', parseFloat(off1.opacity) < 1, '| color', off1.color);
console.log('N2 disabled no glow (shadow = none or card-shadow only):', !off1.boxShadow.includes('255, 90, 95'));

await page.screenshot({ path: `${SHOTS}/gp11-hero-disabled.png`, fullPage: false });

await page.locator('.fw-shield').click({ force: true });
await page.waitForTimeout(500);
const back = await readShield();
console.log('N2 toggle back to enabled reflects immediately (glow back):', back.boxShadow.includes('255, 90, 95'));

const badge = await page.evaluate(() => {
  const b = document.querySelector('.fw-badge');
  return b.textContent.trim();
});
console.log('badge text:', badge);

// wait for a poll cycle (~5s) and confirm enabled stays after backend sync
await page.waitForTimeout(5600);
const afterPoll = await readShield();
console.log('N2 enabled persists after 5s backend poll:', afterPoll.boxShadow.includes('255, 90, 95'));
console.log('PAGE_ERRORS', pageErrors);
await browser.close();
