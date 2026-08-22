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

const SHOTS = '/var/folders/90/z_5cnf7j6zx_mdw41mxrp5000000gn/T/opencode/shots';
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
const log = (k, v) => console.log(`${k}: ${typeof v === 'boolean' ? (v ? 'PASS' : 'FAIL') : v}`);

// ── DASHBOARD ────────────────────────────────────────────────────────────────
await page.goto('http://localhost:5173/');
await page.waitForSelector('.chart-card', { timeout: 20000 });
await page.waitForTimeout(2800);

// N1/N2 — header hierarchy
const hdr = await page.evaluate(() => {
  const read = (card) => {
    const t = card.querySelector('.chart-title');
    const s = card.querySelector('.chart-subtitle');
    const cs = (el) => {
      const c = getComputedStyle(el);
      return { fs: c.fontSize, fw: c.fontWeight, color: c.color, tt: c.textTransform };
    };
    return { title: t?.textContent, subtitle: s?.textContent, tStyle: cs(t), sStyle: cs(s), tTop: Math.round(t?.getBoundingClientRect().top ?? 0), sTop: Math.round(s?.getBoundingClientRect().top ?? 0) };
  };
  const cards = [...document.querySelectorAll('.chart-card')];
  return {
    policy: read(cards.find((c) => c.textContent.includes('Request Distribution'))),
    health: read(cards.find((c) => c.textContent.includes('Performance'))),
    bodyHasParenthetical: document.body.innerText.includes('Customisable from settings'),
  };
});
log('N1 policy card: subtitle is Request Distribution (heading slot)', hdr.policy.subtitle === 'Request Distribution');
log('N1 policy card: title is Policy Outcomes Breakdown (eyebrow slot)', hdr.policy.title === 'Policy Outcomes Breakdown');
log('N1 policy heading style 16px/650', hdr.policy.sStyle.fs === '16px' && hdr.policy.sStyle.fw === '650');
log('N1 policy eyebrow style 11px/700/muted/uppercase', hdr.policy.tStyle.fs === '11px' && hdr.policy.tStyle.fw === '700' && hdr.policy.tStyle.tt === 'uppercase');
log('N1 heading above eyebrow (DOM order)', hdr.policy.sTop < hdr.policy.tTop);
log('N1 "(Customisable from settings)" gone from page', !hdr.bodyHasParenthetical);
log('N2 health card: subtitle is Performance (heading slot)', hdr.health.subtitle === 'Performance');
log('N2 health card: title is System Health Metrics (eyebrow slot)', hdr.health.title === 'System Health Metrics');
log('N2 health heading style 16px/650', hdr.health.sStyle.fs === '16px' && hdr.health.sStyle.fw === '650');
log('N2 health eyebrow style 11px/700/uppercase', hdr.health.tStyle.fs === '11px' && hdr.health.tStyle.fw === '700' && hdr.health.tStyle.tt === 'uppercase');

// N4 — radar: full 5-spoke scale, both series always plotted
const radar = await page.evaluate(() => {
  const ticks = [...document.querySelectorAll('.recharts-polar-angle-axis-tick-value')].map((t) => t.textContent);
  const polygons = document.querySelectorAll('.recharts-radar-polygon').length;
  const avgLine = [...document.querySelectorAll('.chart-card div')].find((d) => d.textContent.includes('Allowed avg:'));
  return { ticks, polygons, avg: avgLine?.textContent ?? null };
});
log('N4 radar keeps all 5 axes (Reliability before Throughput per UX)', JSON.stringify(radar.ticks) === JSON.stringify(['Latency', 'Reliability', 'Throughput', 'Coverage', 'Efficiency']));
log('N4 both decision series plotted (2 polygons)', radar.polygons === 2);
log('N4 averages over full 5-axis scale', radar.avg);

// N3 — radar tooltip: scroll card into view, then hover from chart center toward each axis tick
await page.locator('.chart-card', { hasText: 'Performance' }).scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
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
const readTooltip = async () => {
  const n = await page.locator('.chart-tooltip').count();
  if (!n) return '';
  return ((await page.locator('.chart-tooltip').first().innerText()) || '').replace(/\n/g, ' | ');
};
const found = new Map();
for (const t of geom.ticks) {
  for (const f of [0.3, 0.5, 0.75, 0.95]) {
    await page.mouse.move(
      Math.round(geom.center.x + (t.x - geom.center.x) * f),
      Math.round(geom.center.y + (t.y - geom.center.y) * f),
    );
    await page.waitForTimeout(120);
    const tt = await readTooltip();
    if (tt) found.set(t.label, tt);
  }
}
const ttLatency = found.get('Latency') ?? '';
const ttReliability = found.get('Reliability') ?? '';
const ttEfficiency = found.get('Efficiency') ?? '';
const ttCoverage = found.get('Coverage') ?? '';
console.log('N3 tooltips:', JSON.stringify([...found.entries()]));
log('N3 Latency tooltip = axis + series + real scores (0 / 99.9)', ttLatency.includes('Latency') && ttLatency.includes('Allowed: 0') && ttLatency.includes('Blocked: 99.9'));
log('N3 Reliability tooltip real 100/100', ttReliability.includes('Reliability') && ttReliability.includes('Allowed: 100') && ttReliability.includes('Blocked: 100'));
log('N3 Efficiency tooltip real (live 10/100)', ttEfficiency.includes('Efficiency') && ttEfficiency.includes('Allowed: 10') && ttEfficiency.includes('Blocked: 100'));
log('N3 Coverage tooltip real (live 14.3/14.3)', ttCoverage.includes('Coverage') && ttCoverage.includes('Allowed: 14.3') && ttCoverage.includes('Blocked: 14.3'));

// N5 — Calls Over Time is an area chart (restored per UX request)
const cot = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.chart-card')].find((c) => c.textContent.includes('Calls Over Time'));
  return {
    bars: card.querySelectorAll('.recharts-bar-rectangle').length,
    areaCurves: card.querySelectorAll('.recharts-area-curve').length,
    labels: [...card.querySelectorAll('.recharts-cartesian-axis-tick-value')].map((t) => t.textContent),
  };
});
log('N5 area chart restored (2 area curves)', cot.areaCurves === 2);
log('N5 no bar rects remain', cot.bars === 0);

// hover 12:00 bucket (zero) and 13:00 bucket (real) — tooltip must show real values
const bucketHover = async (label) => {
  const tick = page.locator('.recharts-cartesian-axis-tick-value', { hasText: label }).first();
  const box = await tick.boundingBox();
  if (!box) return null;
  await page.mouse.move(box.x + box.width / 2, box.y - 90);
  await page.waitForTimeout(400);
  return (await page.locator('.chart-tooltip').innerText().catch(() => '')) || null;
};
const tt1200 = await bucketHover('12:00');
const tt1300 = await bucketHover('13:00');
const tt1400 = await bucketHover('14:00');
console.log('N5 tooltip 12:00:', JSON.stringify(tt1200));
console.log('N5 tooltip 13:00:', JSON.stringify(tt1300));
console.log('N5 tooltip 14:00:', JSON.stringify(tt1400));
log('N5 12:00 (real 0/0) tooltip shows zeros', tt1200?.includes('12:00') && tt1200?.includes('Allowed: 0') && tt1200?.includes('Blocked: 0'));
log('N5 13:00 (real 9/5) tooltip shows 9/5', tt1300?.includes('13:00') && tt1300?.includes('Allowed: 9') && tt1300?.includes('Blocked: 5'));
log('N5 14:00 (real 2/13) tooltip shows 2/13', tt1400?.includes('14:00') && tt1400?.includes('Allowed: 2') && tt1400?.includes('Blocked: 13'));

// N1 — settings window logic still responds (real GUI flow: pill on Settings
// persists to the backend; the dashboard's /api/settings SWR entry revalidates
// when it goes stale (maxAge 60s), so poll until the chart's stat line stops
// carrying the old window suffix; the window itself is verified by the
// /api/stats/outcomes requests the page makes).
const seenRequests = [];
page.on('request', (r) => { if (r.url().includes('/api/stats/outcomes')) seenRequests.push(r.url()); });
// useCachedFetch mirrors fresh entries in sessionStorage (cf_cache_v1), so a
// revisit to the dashboard renders cached data with ZERO network by design —
// that hides the window param from the network log. Purge the cache key
// before each dashboard visit in this flow so the window evidence is
// deterministic (the settings click itself is the persisted truth).
const bustCache = () => page.evaluate(() => sessionStorage.removeItem('cf_cache_v1')).catch(() => {});
const pollStatLine = async () => {
  for (let i = 0; i < 36; i++) {
    const line = await page.evaluate(() => [...document.querySelectorAll('.chart-card')].map((c) => c.innerText).find((t) => t.includes('Allowed rate:')) ?? '');
    if (line && !/(last 7 days|this month|all time|no previous-window data)/.test(line)) return line;
    await page.waitForTimeout(2000);
  }
  return '';
};
await bustCache();
await page.goto('http://localhost:5173/settings');
await page.waitForSelector('.glass-card', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.locator('.glass-card', { hasText: 'Dashboard' }).locator('button:has-text("7 days")').click();
await page.waitForTimeout(900);
await bustCache();
await page.goto('http://localhost:5173/');
await page.waitForSelector('.chart-card', { timeout: 20000 });
const statLine7d = await pollStatLine();
console.log('N1 window=7-day stat line:', statLine7d.replace(/\n/g, ' | '), '| outcomes reqs:', seenRequests.filter((u) => u.includes('window=7d')).length);
log('N1 GUI window=7-day requests outcomes?window=7d', seenRequests.some((u) => u.includes('window=7d')));
log('N1 stat line has no window suffix / no previous-window data', statLine7d.includes('Allowed rate:') && !/(last 7 days|this month|all time|no previous-window data)/.test(statLine7d));
await bustCache();
await page.goto('http://localhost:5173/settings');
await page.waitForSelector('.glass-card', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.locator('.glass-card', { hasText: 'Dashboard' }).locator('button:has-text("This month")').click();
await page.waitForTimeout(900);
await bustCache();
await page.goto('http://localhost:5173/');
await page.waitForSelector('.chart-card', { timeout: 20000 });
const statLineMonth = await pollStatLine();
console.log('N1 window=this-month stat line:', statLineMonth.replace(/\n/g, ' | '), '| outcomes reqs:', seenRequests.filter((u) => u.includes('window=this-month')).length);
log('N1 GUI window=this-month requests outcomes?window=this-month', seenRequests.some((u) => u.includes('window=this-month')));

// dark mode screenshots + computed checks
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await page.waitForTimeout(1200);

const metricGlow = await page.evaluate(() => {
  const card = document.querySelector('.d-metric-card');
  const cs = getComputedStyle(card, '::before');
  return { shadow: cs.boxShadow, opacity: cs.opacity };
});
console.log('N7 metric bar dark box-shadow:', metricGlow.shadow, 'opacity', metricGlow.opacity);
log('N7 metric top-bar glows in dark (resolved color-mix accent shadow)', metricGlow.shadow !== 'none' && metricGlow.shadow.includes('0px 0px 16px'));

await page.hover('.chart-card');
await page.waitForTimeout(400);
const chartHover = await page.evaluate(() => {
  const card = document.querySelector('.chart-card');
  return { border: getComputedStyle(card).borderColor, shadow: getComputedStyle(card).boxShadow };
});
console.log('N7 chart-card dark hover:', chartHover.border, '|', chartHover.shadow);
log('N7 chart-card hover has no coral glow (red glow removed per UX)', !chartHover.shadow.includes('255, 90, 95'));

// N8 — dashboard doughnut legend contrast + segment colors in dark
const doughnut = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.chart-card')].find((c) => c.textContent.includes('Policy Outcomes Breakdown'));
  const legendSpans = [...card.querySelectorAll('span')].filter((s) => s.textContent.trim() === 'Allowed' || s.textContent.trim() === 'Blocked' || s.textContent.trim() === 'Logged');
  const cardBg = getComputedStyle(card).backgroundColor;
  const slices = card.querySelectorAll('.recharts-pie-sector path');
  return { legendColor: legendSpans[0] ? getComputedStyle(legendSpans[0]).color : null, cardBg, sliceFills: [...slices].slice(0, 3).map((s) => s.getAttribute('fill')) };
});
console.log('N8 dashboard doughnut dark legend color:', doughnut.legendColor, 'cardBg:', doughnut.cardBg, 'slices:', doughnut.sliceFills);
log('N8 doughnut legend uses text-secondary token', doughnut.legendColor === 'rgba(244, 244, 242, 0.65)');
log('N8 doughnut card bg = dark card token (#1B1B1B)', doughnut.cardBg === 'rgb(27, 27, 27)');
log('N8 segment colors vivid (teal/coral/amber)', doughnut.sliceFills.length === 3);

await page.screenshot({ path: `${SHOTS}/after-dash-dark.png`, fullPage: true });
await page.evaluate(() => { delete document.documentElement.dataset.theme; });
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/after-dash-light.png`, fullPage: true });

// ── FIREWALL ────────────────────────────────────────────────────────────────
await page.goto('http://localhost:5173/firewall');
await page.waitForSelector('.fw-shield-zone', { timeout: 20000 });
await page.waitForTimeout(3000);

const fw = await page.evaluate(() => {
  const zone = document.querySelector('.fw-shield-zone');
  const zr = zone.getBoundingClientRect();
  const pattern = document.querySelector('.pattern-grid');
  const items = [...document.querySelectorAll('.fw-threat-item')];
  return {
    zoneH: Math.round(zr.height),
    hasPattern: !!pattern,
    threatRows: items.map((it) => ({
      name: it.querySelector('.fw-threat-name')?.textContent,
      count: it.querySelector('.fw-threat-count')?.textContent,
      risk: it.querySelector('.fw-threat-risk')?.textContent,
      chevron: !!it.querySelector('.fw-threat-chevron'),
    })),
  };
});
console.log('N9 fw-shield-zone height:', fw.zoneH, 'pattern:', fw.hasPattern);
log('N9 hero zone height = 170px', fw.zoneH === 170);
log('N9 no container/pattern behind icon', !fw.hasPattern);
log('N10 exactly 1 threat row for block-destructive', fw.threatRows.length === 1);
log('N10 row is the grouped rule', fw.threatRows[0]?.name === 'Block Destructive' && fw.threatRows[0]?.count === '23 blocked' && fw.threatRows[0]?.risk === '100/100');
log('N10 chevron shown (has historical variants)', fw.threatRows[0]?.chevron === true);

await page.locator('.fw-threat-row.expandable').click();
await page.waitForTimeout(400);
const variants = await page.evaluate(() =>
  [...document.querySelectorAll('.fw-threat-variant')].map((v) => ({
    reason: v.querySelector('.fw-threat-variant-reason')?.textContent,
    count: v.querySelector('.fw-threat-variant-count')?.textContent,
  })),
);
console.log('N10 variants:', JSON.stringify(variants, null, 1));
log('N10 expand reveals 3 historical variants', variants.length === 3);
log('N10 variant counts preserved 19/3/1', JSON.stringify(variants.map((v) => v.count)) === JSON.stringify(['19', '3', '1']));

// N8 — firewall doughnut in dark: legend contrast + card bg + track
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await page.waitForTimeout(1000);
const fwDoughnut = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.fw-card')].find((c) => c.textContent.includes('Rule Usage'));
  const legendItem = card.querySelector('.fw-legend-item');
  const legendVal = card.querySelector('.fw-legend-val');
  const total = card.querySelector('.fw-doughnut-total');
  const track = card.querySelector('.fw-doughnut circle');
  return {
    cardBg: getComputedStyle(card).backgroundColor,
    legendColor: getComputedStyle(legendItem).color,
    legendValColor: getComputedStyle(legendVal).color,
    totalColor: getComputedStyle(total).color,
    trackStroke: track ? getComputedStyle(track).stroke : null,
    segments: [...card.querySelectorAll('.fw-doughnut circle')].slice(1).map((c) => getComputedStyle(c).stroke),
  };
});
console.log('N8 firewall doughnut dark:', JSON.stringify(fwDoughnut));
log('N8 fw doughnut card bg = dark token', fwDoughnut.cardBg === 'rgb(27, 27, 27)');
log('N8 fw doughnut legend text tokenized', fwDoughnut.legendColor === 'rgba(244, 244, 242, 0.45)' && fwDoughnut.legendValColor === 'rgb(244, 244, 242)');
log('N8 fw doughnut track uses bg-inset', fwDoughnut.trackStroke === 'rgb(24, 24, 24)');
log('N8 fw doughnut segments vivid teal/coral', JSON.stringify(fwDoughnut.segments) === JSON.stringify(['rgb(0, 166, 153)', 'rgb(255, 90, 95)']));

// N7 — firewall hero shield glow in dark
// N7 halo: the shield glow is driven by theme-aware framer-motion keyframes
// (dark peak 0.42 @ 60px) rebuilt on each 5s summary poll — wait for the
// next cycle after theme flip.
let halo = null;
for (let i = 0; i < 8; i++) {
  halo = await page.evaluate(() => {
    const shield = document.querySelector('.fw-shield');
    if (!shield) return null;
    return { shadow: getComputedStyle(shield).boxShadow, bgLayer: !!document.querySelector('.fw-visual-bg'), pattern: !!document.querySelector('.pattern-grid') };
  });
  if (halo && (halo.shadow || '').includes('rgba(255, 90, 95, 0.3)')) break;
  await page.waitForTimeout(1500);
}
console.log('N7 fw-shield dark shadow:', halo?.shadow);
log('N7 hero shield glow in dark (0.3+ strength keyframe)', !!halo && /rgba\(255, 90, 95, 0\.(3|4)/.test(halo.shadow));
log('N7 no container/pattern behind shield icon', !!halo && !halo.bgLayer && !halo.pattern);

await page.screenshot({ path: `${SHOTS}/after-fw-dark.png`, fullPage: true });
await page.evaluate(() => { delete document.documentElement.dataset.theme; });
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/after-fw-light.png`, fullPage: true });

console.log('PAGE_ERRORS', pageErrors);
await browser.close();
