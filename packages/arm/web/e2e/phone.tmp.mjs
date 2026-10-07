import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://localhost:3370/?relay=ws%3A%2F%2Flocalhost%3A4470&token=pt_2629041a2ac33a569c6fe8c9287e2f8493112f0fe031ffd9ae71c4ea03618600&fp=rm2YLzHFin_WP686spEYaA');
await p.waitForTimeout(12000);
console.log('phone status', await p.evaluate(() => window.__krakiStore?.getState().status));
await b.close();
