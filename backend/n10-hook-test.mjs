import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(15000);
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('pageerror:', e.message); });

await page.goto('http://localhost:5173/test-hook/');
await page.waitForSelector('#state', { timeout: 10000 });
const state = () => page.locator('#state').innerText();

// phase 1: initial mount → loading, then slow fetch completes → "1"
const t0 = Date.now();
let s1 = await state();
const loadingSeen = s1 === 'loading';
await page.waitForFunction(() => document.getElementById('state')?.innerText === '1', null, { timeout: 5000 });
const tFetch = Date.now() - t0;

// unmount + remount quickly: cache fresh (age < 300ms) → instant "1", no loading flash
await page.evaluate(() => window.unmount());
await page.waitForTimeout(50);
await page.evaluate(() => window.mount());
const seen = [];
for (let i = 0; i < 20; i++) { seen.push(await state()); await page.waitForTimeout(15); }
const flashAfterRemount = seen.slice(0, 5).includes('loading');

// wait past maxAge(300ms) + fetch(200ms): background revalidation → "2"
await page.waitForFunction(() => document.getElementById('state')?.innerText === '2', null, { timeout: 5000 });
const calls = await page.evaluate(() => window.callsRef());
console.log('phase1 loading-seen:', loadingSeen, `| fetch latency ~${tFetch}ms`);
console.log('after remount states:', seen.join(' '));
console.log('loading flash after remount:', flashAfterRemount);
console.log('background revalidation reached 2:', true, `(calls=${calls})`);
console.log(`page errors: ${pageErrors}`);
console.log('ALL_DONE');
await browser.close();
