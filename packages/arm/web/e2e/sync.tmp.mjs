import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
await p.goto('http://localhost:3470/', { waitUntil: 'networkidle' }).catch(() => {});
await p.waitForTimeout(7000);
await p.locator('[aria-label=Settings]').first().click();
await p.locator('[data-testid=settings-voice]').first().waitFor({ timeout: 20000 });
console.log('mac browser sees:', JSON.stringify(await p.locator('[data-testid=voice-words]').first().innerText()));
// add one here; the PC should get it live
await p.locator('[aria-label="Custom word"]').first().fill('kubectl'); await p.locator('[aria-label="Often heard as"]').first().fill('cube control'); await p.locator('[aria-label="Often heard as"]').first().press('Enter');
await p.waitForTimeout(2500);
await b.close();
