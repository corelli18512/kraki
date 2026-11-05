import { test, expect, type Page } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';

// K-316: a draft that wraps at the one-row width but fits the stacked
// (multiline) width made the composer flip between the two layouts until
// React gave up ("Maximum update depth exceeded", the error screen; the
// persisted draft then crashed every reload). Each length from one row to well
// past the wrap must settle.
const SESSION = { id: 'sess-wrap', deviceId: 'tentacle-1', deviceName: 'Mac', agent: 'pi', model: 'm', state: 'idle', messageCount: 0, title: 'Wrap' };
const DEVICE = { id: 'tentacle-1', name: 'Mac', role: 'tentacle', kind: 'cli', online: true };

async function open(page: Page, server: MockRelayServer, width: number) {
  await page.setViewportSize({ width, height: 720 });
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?relay=${encodeURIComponent(server.url)}`);
  const ws = await server.waitForConnection();
  await server.waitForMessage(ws);
  server.sendAuthOk(ws, { sessions: [SESSION], devices: [DEVICE] });
  await server.waitForMessage(ws);
  await page.getByText('Wrap').first().click();
  await expect(page.locator('[data-chat-scroll]')).toBeVisible();
}

for (const width of [1200, 1240, 900, 390]) {
  test(`composer settles for every draft length around the wrap width (${width}px)`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const server = await MockRelayServer.create();
    try {
      await open(page, server, width);
      const field = page.locator('.kcomposer textarea');
      const fieldWidth = await field.evaluate((el) => el.getBoundingClientRect().width);
      // ~8 px per character: scan from one row to past the stacked width.
      const from = Math.max(1, Math.floor(fieldWidth / 12));
      const to = Math.ceil(fieldWidth / 4);
      for (const unit of ['The quick brown fox jumps over the lazy dog. ', 'x']) {
        for (let length = from; length <= to; length++) {
          await field.fill(unit.repeat(length).slice(0, length), { timeout: 2000 });
          // React's error boundary catches the update loop: no page error.
          await expect(page.getByText('Something went wrong'), `${length} characters`).toHaveCount(0, { timeout: 100 });
        }
        // The longest draft wraps: the controls stack under the text.
        await expect(page.locator('.kcomposer-field.is-multiline')).toHaveCount(1);
      }
      await page.waitForTimeout(200);
      expect(errors).toEqual([]);
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      await expect(field).toBeVisible();
    } finally {
      await server.close();
    }
  });
}
