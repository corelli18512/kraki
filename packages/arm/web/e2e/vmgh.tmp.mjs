import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
const pages = b.contexts().flatMap((c) => c.pages());
const gh = pages.find((p) => p.url().includes('github.com'));
console.log(gh ? gh.url().slice(0, 90) : 'no github page', gh ? await gh.title() : '');
if (gh) await gh.screenshot({ path: '/tmp/vm/gh.png' });
await b.close().catch(() => {}); process.exit(0);
