import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
await p.goto('http://localhost:3470/', { waitUntil: 'networkidle' }).catch(() => {});
await p.waitForTimeout(7000);
const log = await p.evaluate(async () => {
  const s = window.__krakiStore;
  const out = [`start ${s.getState().status} dev=${s.getState().deviceId}`];
  s.subscribe((st, prev) => { if (st.status !== prev.status) out.push(`${st.status} dev=${st.deviceId}`); });
  window.__out = out; return out;
});
console.log(log);
await p.waitForTimeout(45000);
console.log(await p.evaluate(() => window.__out), await p.locator('[data-testid=account-deleted-notice]').count());
await b.close();
