import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
await p.goto('http://localhost:3470/', { waitUntil: 'networkidle' }).catch(() => {});
await p.waitForTimeout(8000);
console.log(JSON.stringify(await p.evaluate(() => {
  const s = window.__krakiStore.getState();
  const pc = [...s.devices.values()].find((d) => d.name === 'Alex-PC');
  return { pc: pc?.id, update: s.deviceUpdates.get(pc?.id) };
})));
await b.close();
