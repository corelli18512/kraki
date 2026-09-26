// Web chat UX gate against the LOCAL stack only (never production). Drives
// the real app in Chrome with a real agent and records every animation frame
// of the chat list (probe.js), then counts blank gaps, rows that vanish and
// come back, and on-screen jumps (analyze.mjs).
//
//   KRAKI_LOCAL_RELAY_PORT=4470 KRAKI_LOCAL_WEB_PORT=3370 KRAKI_LOCAL_REDIRECT_PORT=3470 \
//     pnpm exec tsx scripts/dev-local.ts --no-open
//   pnpm exec tsx scripts/e2e/seed-design-sessions.ts        # sessions → /tmp/kraki-design-sessions.json
//   cd packages/arm/web && SESSION=<id> [MOBILE=1] [DARK=1] node e2e/local-stack/chat-gate.mjs \
//     send|answer|permission|abort|image <out-dir>
import { chromium } from '@playwright/test';
const [,, scenario, out] = process.argv;
const mobile = !!process.env.MOBILE;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: mobile ? { width: 402, height: 874 } : { width: 1280, height: 860 }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: process.env.DARK ? 'dark' : 'light' });
const page = await ctx.newPage();
import { readFileSync } from 'node:fs';
import { analyze } from './analyze.mjs';
await page.addInitScript(readFileSync(new URL('./probe.js', import.meta.url), 'utf8'));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto('http://localhost:3470/', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(7000);
await page.evaluate((t) => { history.pushState({}, '', t); dispatchEvent(new PopStateEvent('popstate')); }, `/session/${process.env.SESSION}`);
await page.waitForTimeout(5000);
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const distance = () => page.evaluate(() => { const s = document.querySelector('.kchat-list [data-virtuoso-scroller], .kchat-list'); return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1; });
await shot('0-open');
if (scenario === 'answer') {
  await page.evaluate(() => window.__kprobe.start());
  await page.getByRole('button', { name: 'Answer: Production' }).click();
  await page.waitForTimeout(400);
  await shot('1-answered');
  console.log('choices after answer', await page.getByRole('button', { name: /^Answer:/ }).count());
  await page.getByText(/production/i).last().waitFor({ timeout: 5000 });
  for (let i = 0; i < 120; i++) { await page.waitForTimeout(1000); if (await page.locator('[data-testid="chat-send"]').count()) { const busy = await page.locator('[data-testid="chat-stop"]').count(); if (!busy && i > 3) break; } }
  await page.waitForTimeout(1500);
  await shot('2-reply');
  console.log('distance to bottom', await distance());
  const frames = await page.evaluate(() => window.__kprobe.stop());
  const r = analyze(frames, { topInset: mobile ? 64 : 56 });
  console.log('PROBE', JSON.stringify({ frames: r.frames, blanks: r.blanks, flashes: r.flashes, jumps: r.jumps }));
  r.log.forEach((l) => console.log('  ', l));
  if (process.env.DBG) { const m = r.log.map((l) => Number(/#(\d+)/.exec(l)?.[1])).filter(Boolean)[0]; if (m) for (let i = m - 5; i <= m; i++) console.log('DBG', i, JSON.stringify(frames[i].dbg), frames[i].rows.map((x) => x.key + '@' + x.top).join(',')); }
} else if (scenario === 'permission') {
  await page.getByRole('button', { name: /Discuss|Safe|Execute|Delegate/ }).first().click();
  await page.getByRole('menuitemradio', { name: /Safe/ }).click();
  await page.waitForTimeout(800);
  await page.locator('.kcomposer textarea').fill('Use the bash tool to run exactly: ls / — then tell me how many entries there are in one sentence.');
  await page.evaluate(() => window.__kprobe.start());
  await page.locator('[data-testid="chat-send"]').click();
  await page.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 90000 });
  await page.waitForTimeout(500);
  await shot('1-permission');
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForTimeout(300);
  await shot('2-approved');
  for (let i = 0; i < 120; i++) { await page.waitForTimeout(1000); if (!(await page.locator('[data-testid="chat-stop"]').count())) break; }
  await page.waitForTimeout(1500);
  await shot('3-done');
  console.log('distance to bottom', await distance());
  await page.getByRole('button', { name: /Safe/ }).first().click();
  await page.getByRole('menuitemradio', { name: /Discuss/ }).click();
  const frames = await page.evaluate(() => window.__kprobe.stop());
  const r = analyze(frames, { topInset: mobile ? 64 : 56 });
  console.log('PROBE', JSON.stringify({ frames: r.frames, blanks: r.blanks, flashes: r.flashes, jumps: r.jumps }));
  r.log.forEach((l) => console.log('  ', l));
  if (process.env.DBG) { const m = r.log.map((l) => Number(/#(\d+)/.exec(l)?.[1])).filter(Boolean)[0]; if (m) for (let i = m - 5; i <= m; i++) console.log('DBG', i, JSON.stringify(frames[i].dbg), frames[i].rows.map((x) => x.key).join(',')); }
} else if (scenario === 'abort') {
  await page.locator('.kcomposer textarea').fill('Write a very long essay (at least 1500 words) about the history of computing.');
  await page.evaluate(() => window.__kprobe.start());
  await page.locator('[data-testid="chat-send"]').click();
  for (let i = 0; i < 60; i++) { await page.waitForTimeout(500); if (await page.locator('[data-row-key="__live__"] .kmd').count()) break; }
  await page.waitForTimeout(2500);
  await shot('1-streaming');
  await page.locator('[data-testid="chat-stop"]').click();
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(500); if (await page.getByText('User aborted').count()) break; }
  await page.waitForTimeout(1500);
  await shot('2-aborted');
  console.log('user aborted shown', await page.getByText('User aborted').count(), 'distance', await distance());
  const frames = await page.evaluate(() => window.__kprobe.stop());
  const r = analyze(frames, { topInset: mobile ? 64 : 56 });
  console.log('PROBE', JSON.stringify({ frames: r.frames, blanks: r.blanks, flashes: r.flashes, jumps: r.jumps }));
  r.log.forEach((l) => console.log('  ', l));
} else if (scenario === 'image') {
  const { writeFileSync } = await import('node:fs');
  // A 200×120 PNG: a blue square on white (generated in the page).
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 200, 120); g.fillStyle = '#1d4ed8'; g.fillRect(60, 20, 80, 80); return c.toDataURL('image/png').split(',')[1]; });
  writeFileSync('/tmp/wp-square.png', Buffer.from(png, 'base64'));
  await page.locator('.kcomposer input[type=file]').setInputFiles('/tmp/wp-square.png');
  await page.waitForTimeout(500);
  await page.locator('.kcomposer textarea').fill('What color is the square in this image? One word.');
  await shot('1-attached');
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForTimeout(600);
  await shot('2-sent');
  for (let i = 0; i < 120; i++) { await page.waitForTimeout(1000); if (i > 3 && !(await page.locator('[data-testid="chat-stop"]').count())) break; }
  await page.waitForTimeout(1500);
  await shot('3-done');
  console.log('images in user bubbles', await page.locator('.krow-user img').count(), 'distance', await distance());
} else if (scenario === 'send') {
  const field = page.locator('.kcomposer textarea');
  await field.fill(process.env.TEXT ?? 'Reply with a numbered list of 12 short facts about octopuses.');
  await page.evaluate(() => window.__kprobe.start());
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForTimeout(300);
  await shot('1-sent');
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(700); await shot(`2-stream-${i}`); }
  for (let i = 0; i < 120; i++) { await page.waitForTimeout(1000); if (!(await page.locator('[data-testid="chat-stop"]').count())) break; }
  await page.waitForTimeout(1500);
  await shot('3-done');
  console.log('distance to bottom', await distance());
  const frames = await page.evaluate(() => window.__kprobe.stop());
  const r = analyze(frames, { topInset: mobile ? 64 : 56 });
  console.log('PROBE', JSON.stringify({ frames: r.frames, blanks: r.blanks, flashes: r.flashes, jumps: r.jumps }));
  r.log.forEach((l) => console.log('  ', l));
  if (process.env.DBG) { const m = r.log.map((l) => Number(/#(\d+)/.exec(l)?.[1])).filter(Boolean)[0]; if (m) for (let i = m - 5; i <= m; i++) console.log('DBG', i, JSON.stringify(frames[i].dbg), frames[i].rows.map((x) => x.key + '@' + x.top).join(',')); }
}
console.log('errors', JSON.stringify(errors.slice(0, 8)));
await browser.close();
