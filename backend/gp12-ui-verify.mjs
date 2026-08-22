// P12-N6/N7 — protection-status UI verification.
// Agents page: OpenCode shows "Protected" (config rewired post-N3), Claude
// Code + Codex honestly show "Detected only — not protected". Firewall page:
// hero copy carries the real X-of-Y protected count (no all-protected claim).
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
});

// ── N6: Agents page ──
await page.goto('http://localhost:5173/agents');
await page.waitForSelector('.ag-card', { timeout: 20000 });
await page.waitForTimeout(1500);

const cards = await page.evaluate(() => {
  return [...document.querySelectorAll('.ag-card')].map((c) => {
    const name = c.querySelector('.ag-card-name')?.textContent ?? '';
    const badge = c.querySelector('.ag-protect-badge');
    return {
      name,
      badgeText: badge?.textContent?.trim() ?? null,
      badgeClass: badge?.className ?? null,
      title: badge?.getAttribute('title')?.slice(0, 90) ?? null,
    };
  });
});
console.log('N6 agents badges:', JSON.stringify(cards, null, 1));

const subtitle = await page.textContent('.ag-subtitle');
console.log('N6 subtitle:', subtitle);
await page.screenshot({ path: `${SHOTS}/gp12-agents-protected.png`, fullPage: true });

// ── N6 detail page: OpenCode shows protection panel + Unprotect button ──
await page.goto('http://localhost:5173/agents/opencode');
await page.waitForSelector('.section-title', { timeout: 20000 });
await page.waitForTimeout(1200);
const detail = await page.evaluate(() => ({
  badge: document.querySelector('.ag-detail-protect')?.textContent?.trim() ?? null,
  badgeClass: document.querySelector('.ag-detail-protect')?.className ?? null,
  panel: document.querySelector('.glass-card .font-bold')?.textContent ?? null,
  backupLine: [...document.querySelectorAll('.font-mono')].map((e) => e.textContent).find((t) => t?.includes('cf-backup')) ?? null,
  button: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).find((t) => t?.includes('Unprotect')) ?? null,
}));
console.log('N6 opencode detail:', JSON.stringify(detail, null, 1));
await page.screenshot({ path: `${SHOTS}/gp12-opencode-detail-protected.png`, fullPage: true });

// ── N7: Firewall page — honest X-of-Y copy ──
await page.goto('http://localhost:5173/firewall');
await page.waitForSelector('.fw-hero-subtitle', { timeout: 20000 });
await page.waitForTimeout(2000);
const hero = await page.textContent('.fw-hero-subtitle');
console.log('N7 firewall hero subtitle:', hero);
await page.screenshot({ path: `${SHOTS}/gp12-firewall-honest-copy.png`, fullPage: true });

console.log('PAGE_ERRORS', pageErrors);
await browser.close();
