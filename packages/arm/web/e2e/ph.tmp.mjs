// Persistent "phone": node ph.tmp.mjs URL [script-file]
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const ctx = await chromium.launchPersistentContext('/tmp/vm/phone-profile', { channel: 'chrome', viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = ctx.pages()[0] ?? await ctx.newPage();
await p.goto(process.argv[2]);
await p.waitForTimeout(6000);
if (process.argv[3]) { const fn = new Function('p', 'return (async () => {' + readFileSync(process.argv[3], 'utf8') + '})()'); await fn(p); }
await ctx.close();
