import { test, expect, type Page } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';
import type { WebSocket } from 'ws';

/**
 * Pulse-enabled browser pass — the real web arm, built with VITE_KRAKI_PULSE=1.
 *
 * The mock relay speaks the LEGACY plaintext envelope (no E2E, no `pulse`
 * field), so inbound messages have no pulse frame and flow through the arm's
 * legacy path unchanged. This proves the key regression property: turning pulse
 * ON does not break the browser boot / auth / render pipeline.
 *
 * (The full per-hop pulse path with real E2E crypto — tentacle ⇄ head hub ⇄ app,
 * durable store, head restart — is proven in packages/tests/pulse-e2e.test.ts
 * and packages/head/src/__tests__/pulse-hub.test.ts against real servers.)
 */

const SESSION_ID = 'session-pulse';
const DEVICE_ID = 'tentacle-pulse';

const TEST_SESSION = {
  id: SESSION_ID,
  deviceId: DEVICE_ID,
  deviceName: 'Pulse Tentacle',
  agent: 'copilot',
  model: 'gpt-4',
  state: 'active',
  messageCount: 0,
};
const TEST_DEVICE = { id: DEVICE_ID, name: 'Pulse Tentacle', role: 'tentacle', kind: 'cli', online: true };

async function gotoWithRelay(page: Page, server: MockRelayServer): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?relay=${encodeURIComponent(server.url)}`);
}

async function authenticate(server: MockRelayServer): Promise<WebSocket> {
  const ws = await server.waitForConnection();
  await server.waitForMessage(ws);
  server.sendAuthOk(ws, { sessions: [TEST_SESSION], devices: [TEST_DEVICE] });
  await server.waitForMessage(ws);
  return ws;
}

test.describe('pulse-enabled build', () => {
  let server: MockRelayServer;

  test.beforeEach(async () => {
    server = await MockRelayServer.create();
  });
  test.afterEach(async () => {
    await server.close();
  });

  test('boots, connects, and renders a session with pulse enabled', async ({ page }) => {
    await gotoWithRelay(page, server);
    const ws = await authenticate(server);

    // Session appears in the sidebar (session_list processed through the real
    // arm pipeline while pulse is active).
    const sessionCard = page.getByText('Copilot').first();
    await expect(sessionCard).toBeVisible({ timeout: 5000 });
    await sessionCard.click();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 3000 });

    // A live agent_message (legacy plaintext, no pulse frame) still renders —
    // pulse ON must not swallow or break normal messages.
    server.sendMessage(ws, {
      type: 'agent_message',
      sessionId: SESSION_ID,
      seq: 1,
      payload: { content: 'pulse build renders this' },
    });
    await expect(page.getByText('pulse build renders this')).toBeVisible({ timeout: 5000 });
  });
});
