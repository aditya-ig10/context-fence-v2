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
page.setDefaultTimeout(20000);
let pageErrors = 0;
page.on('pageerror', () => pageErrors++);
await page.route('**/src/lib/firebase.ts', (r) => r.fulfill({ body: MOCK_FIREBASE, contentType: 'application/javascript' }));
await page.addInitScript(() => {
  localStorage.setItem('cf_mock_user', '1');
  localStorage.setItem('cf_has_session', 'true');
  localStorage.setItem('cf_onboarding_seen', 'true');
});

// Heading hierarchy of the two dashboard cards
await page.goto('http://localhost:5173/');
await page.waitForSelector('.chart-title', { timeout: 20000 });
await page.waitForTimeout(2500);
const headings = await page.evaluate(() => {
  const out = [];
  for (const card of document.querySelectorAll('.chart-card')) {
    const t = card.querySelector('.chart-title');
    const s = card.querySelector('.chart-subtitle');
    if (!t || !s) continue;
    const style = (el) => {
      const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color, textTransform: cs.textTransform, letterSpacing: cs.letterSpacing, marginTop: cs.marginTop };
    };
    const ta = t.getBoundingClientRect(), sa = s.getBoundingClientRect();
    out.push({
      title: t.textContent, titleStyle: style(t), titleY: Math.round(ta.top),
      subtitle: s.textContent, subtitleStyle: style(s), subtitleY: Math.round(sa.top),
      order: ta.top <= sa.top ? 'title-above-subtitle' : 'subtitle-above-title',
    });
  }
  return out;
});
console.log(JSON.stringify(headings, null, 1));

// Calls over time: dump rendered data values per bucket label (from tooltip trigger area) — check raw data via API instead
const timeline = await page.evaluate(async () => (await fetch('/api/stats/timeline?period=today')).json());
console.log('TIMELINE_TODAY', JSON.stringify(timeline.buckets));

console.log('PAGE_ERRORS', pageErrors);
await browser.close();
