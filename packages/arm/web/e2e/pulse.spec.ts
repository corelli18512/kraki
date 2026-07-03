import { test, expect, type Page } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';
import type { WebSocket } from 'ws';

/**
 * Pulse-enabled browser smoke — the real web arm, built with VITE_KRAKI_PULSE=1,
 * must still boot, connect, authenticate, and render a live session.
 *
 * The mock relay speaks PLAINTEXT (no E2E), so messages arrive un-pulse-framed;
 * the arm's PulseClient.tryFrame() returns false for them and they flow through
 * the normal pipeline. This verifies the crucial property that turning pulse ON
 * does not break the existing browser transport/auth/render path — the
 * regression risk of the integration. (End-to-end pulse resume-across-disconnect
 * is proven deterministically in packages/tests/pulse-integration.test.ts, which
 * exercises the real E2E crypto path pulse frames actually ride.)
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

    // A live agent_message (plaintext, non-pulse) still renders — pulse ON must
    // not swallow or break normal messages.
    server.sendMessage(ws, {
      type: 'agent_message',
      sessionId: SESSION_ID,
      seq: 1,
      payload: { content: 'pulse build renders this' },
    });
    await expect(page.getByText('pulse build renders this')).toBeVisible({ timeout: 5000 });
  });
});
