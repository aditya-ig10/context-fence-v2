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

await page.goto('http://localhost:5173/logs');
await page.waitForSelector('.data-table tbody tr', { timeout: 20000 });
await page.waitForTimeout(1500);

const cells = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.data-table tbody tr')].slice(0, 8);
  return rows.map((r) => {
    const tds = [...r.querySelectorAll('td')];
    const agent = tds[1];
    const img = agent.querySelector('img');
    return {
      agentText: agent.textContent.trim(),
      hasServerIcon: !!agent.querySelector('svg'),
      imgSrc: img ? img.getAttribute('src').split('/').pop() : null,
      unknownBadge: !!agent.querySelector('.agent-unknown-badge'),
      badgeText: agent.querySelector('.agent-unknown-badge')?.textContent ?? null,
      rowWidth: r.getBoundingClientRect().width,
      tableWidth: document.querySelector('.data-table').getBoundingClientRect().width,
      cardWidth: document.querySelector('.data-table-card').getBoundingClientRect().width,
    };
  });
});
console.log(JSON.stringify(cells, null, 1));
console.log('N7 no horizontal overflow:', cells.every((c) => c.rowWidth <= c.cardWidth));
console.log('PAGE_ERRORS', pageErrors);

await page.screenshot({ path: `${SHOTS}/gp11-audit-dark.png` });

await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/gp11-audit-light.png` });

// export CSV sanity: agent column still present
const csv = await page.evaluate(() => fetch('/api/logs/export?format=csv').then((r) => r.text()));
console.log('CSV header:', csv.split('\n')[0]);
await browser.close();
