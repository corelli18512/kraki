import { test, expect, type Page } from '@playwright/test';
import type { Store } from '../src/types/store';
import { MockRelayServer } from './helpers/mock-ws-server';

const SESSION = 'steer-placement';
type DiagnosticWindow = Window & { __krakiStore: { getState(): Store } };

// The mock has no E2E key/subscription handshake. Drive only draft deltas via
// the existing localhost store probe; local sends and echoed spine rows use
// the production composer/outbox and mock relay respectively.
async function delta(page: Page, text: string, reset = false) {
  await page.evaluate(({ sessionId, text, reset }) => {
    (window as DiagnosticWindow).__krakiStore.getState().applyCardMessage(sessionId, text, reset);
  }, { sessionId: SESSION, text, reset });
}

async function expectOrder(page: Page, liveFirst: boolean) {
  const live = page.locator('[data-scroll-key="__live__"]');
  const steer = page.locator('[data-scroll-key]').filter({ hasText: 'Use the new API' });
  await expect(live).toHaveCount(1);
  await expect(steer).toHaveCount(1);
  await expect.poll(async () => {
    const a = await live.boundingBox();
    const b = await steer.boundingBox();
    if (!a || !b) return false;
    return liveFirst ? a.y + a.height <= b.y + 1 : b.y + b.height <= a.y + 1;
  }).toBe(true);
}

for (const echoAfterReset of [false, true]) {
  test(`steer keeps streamed segment above it, then follows reset (echo ${echoAfterReset ? 'after' : 'before'} reset)`, async ({ page }) => {
    const server = await MockRelayServer.create();
    try {
      await page.setViewportSize({ width: 1240, height: 720 });
      const connection = server.waitForConnection();
      await page.goto(`/?relay=${encodeURIComponent(server.url)}`);
      const ws = await connection;
      server.sendAuthOk(ws, {
        devices: [{ id: 'tentacle-1', name: 'Mock', role: 'tentacle', kind: 'cli', online: true }],
        sessions: [{ id: SESSION, deviceId: 'tentacle-1', agent: 'pi', state: 'active', title: 'Steer placement' }],
      });
      await page.getByText('Steer placement', { exact: true }).first().click();
      await expect(page.locator('[data-chat-scroll]')).toBeVisible();
      for (let i = 1; i <= 25; i++) {
        server.sendMessage(ws, { type: i % 2 ? 'user_message' : 'agent_message', sessionId: SESSION,
          seq: i, payload: { content: `History ${i}: ${'some content '.repeat(14)}` } });
      }
      await expect(page.locator('[data-scroll-key="25"]')).toBeVisible();
      await delta(page, 'I will start with the parser.');
      const live = page.locator('[data-scroll-key="__live__"]');
      await expect(live).toBeVisible();
      await live.evaluate((el) => { (el as HTMLElement).dataset.identity = 'original-live-row'; });
      await page.locator('textarea').fill('Use the new API');
      await page.locator('textarea').press('Enter');
      await expectOrder(page, true);
      // Isolate placement from chat-scroll F6 (smooth send navigation racing
      // streaming follow), owned by the scroll-follow lane. The glide has a
      // 900ms completion fallback; wait for that ownership to end first.
      await page.waitForTimeout(1000);
      await delta(page, ' Then the lexer.');
      await expectOrder(page, true);
      const clientId = await page.evaluate((sessionId) =>
        (window as DiagnosticWindow).__krakiStore.getState().cards.get(sessionId)?.steer?.anchor, SESSION);
      expect(clientId).toBeTruthy();
      const echo = () => server.sendMessage(ws, { type: 'user_message', sessionId: SESSION, seq: 26,
        payload: { content: 'Use the new API', delivery: 'steer', clientId } });
      if (!echoAfterReset) {
        echo();
        await expect(page.locator('[data-scroll-key="26"]')).toBeAttached();
        await expectOrder(page, true);
      }
      await delta(page, 'Switching to the new API.', true);
      await expectOrder(page, false);
      if (echoAfterReset) {
        echo();
        await expect(page.locator('[data-scroll-key="26"]')).toBeAttached();
        await expectOrder(page, false);
      }
      await expect(live).toHaveAttribute('data-identity', 'original-live-row');
      // Growth after the move is still followed at the conversation tail.
      for (let i = 0; i < 8; i++) await delta(page, `\n\nNew segment paragraph ${i}. ${'New API details. '.repeat(12)}`);
      await expect.poll(() => page.locator('[data-chat-scroll]').evaluate((el) => {
        const reach = el.querySelector<HTMLElement>('.kchat-overlay-reach')?.offsetHeight ?? 0;
        return el.scrollHeight - el.clientHeight - reach - el.scrollTop;
      })).toBeLessThan(2);
      await expectOrder(page, false);
    } finally {
      await server.close();
    }
  });
}
