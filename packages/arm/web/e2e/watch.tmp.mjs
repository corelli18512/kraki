import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
await p.goto('http://localhost:3470/', { waitUntil: 'networkidle' }).catch(() => {});
await p.waitForTimeout(7000);
console.log('mac browser before:', await p.evaluate(() => window.__krakiStore.getState().status));
await p.waitForTimeout(40000);
console.log('mac browser after:', await p.evaluate(() => window.__krakiStore.getState().status), await p.locator('[data-testid=account-deleted-notice]').count() > 0 ? 'notice shown' : 'no notice');
await b.close();
