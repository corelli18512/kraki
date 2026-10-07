import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const sessions = JSON.parse(readFileSync('/tmp/subagent-shots/sessions.json', 'utf8'));
const out = '/tmp/subagent-shots/png';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto('http://localhost:3480/', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(7000);
for (const [agent, id] of Object.entries(sessions)) {
  await page.evaluate((t) => { history.pushState({}, '', t); dispatchEvent(new PopStateEvent('popstate')); }, `/session/${id}`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/${agent}-1.png` });
  const btn = page.getByRole('button', { name: 'Show steps' }).last();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${agent}-2.png` });
    const cards = page.locator('.ksub-card');
    const n = await cards.count();
    console.log(agent, 'subagent cards', n);
    for (let i = 0; i < Math.min(n, 2); i++) {
      await page.locator('.ksub-card').nth(i).click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${out}/${agent}-3-${i}.png` });
      // nested (pi parallel): open the first inner card once
      const inner = page.locator('.ksub-card');
      if (await inner.count()) {
        await inner.first().click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: `${out}/${agent}-4-${i}.png` });
        await page.locator('.ksheet-back').click();
        await page.waitForTimeout(500);
      }
      await page.locator('.ksheet-back').click();
      await page.waitForTimeout(500);
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('.ksheet-close').click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(500);
}
await browser.close();
