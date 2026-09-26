// Older-page gate (local stack only): open a long session, wheel up to the
// first turn, and assert no blank gaps / flashes / jumps; ↓ returns to the end.
//   SESSION=<id from SEED=history seed-design-sessions.ts> [MOBILE=1] node e2e/local-stack/paging-gate.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { analyze } from './analyze.mjs';
const mobile = !!process.env.MOBILE;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: mobile ? { width: 402, height: 874 } : { width: 1280, height: 860 }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
const page = await ctx.newPage();
await page.addInitScript(readFileSync(new URL('./probe.js', import.meta.url), 'utf8'));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:3470/', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(6000);
const sid = process.env.SESSION;
// Fresh client: clear this session's cached rows so paging must go to the Tentacle.
await page.evaluate((t) => { history.pushState({}, '', t); dispatchEvent(new PopStateEvent('popstate')); }, `/session/${sid}`);
await page.waitForTimeout(5000);
const count = () => page.evaluate((s) => (window.__krakiStore.getState().messages.get(s) ?? []).filter((m) => Number.isInteger(m.seq) && m.seq > 0).length, sid);
const low = () => page.evaluate((s) => Math.min(...(window.__krakiStore.getState().messages.get(s) ?? []).map((m) => m.seq).filter((x) => Number.isInteger(x) && x > 0)), sid);
console.log('open: rows', await count(), 'lowest seq', await low());
await page.evaluate(() => window.__kprobe.start());
const box = await page.locator('.kchat-list').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 90; i++) {
  await page.mouse.wheel(0, -260);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(1500);
const frames = await page.evaluate(() => window.__kprobe.stop());
const r = analyze(frames, { topInset: mobile ? 64 : 56 });
console.log('after scrolling up: rows', await count(), 'lowest seq', await low());
console.log('first turn visible', await page.getByText('History turn 1:', { exact: false }).count());
console.log('PROBE', JSON.stringify({ frames: r.frames, blanks: r.blanks, flashes: r.flashes, jumps: r.jumps }));
r.log.forEach((l) => console.log('  ', l));
await page.screenshot({ path: process.env.OUT ?? '/tmp/kraki-web-paging-top.png' });
// ↓ button back to latest
await page.getByRole('button', { name: 'Jump to latest' }).click();
await page.waitForTimeout(1500);
const dist = await page.evaluate(() => { const s = document.querySelector('.kchat-list'); return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight); });
console.log('after ↓ distance', dist);
console.log('errors', JSON.stringify(errors.slice(0, 5)));
await browser.close();
