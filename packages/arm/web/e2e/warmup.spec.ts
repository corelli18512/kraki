import { test, expect, type Page, type Locator } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';
import type { WebSocket } from 'ws';

const DEVICE_ID = 'tentacle-1';

const TEST_DEVICE = {
  id: DEVICE_ID,
  name: 'Test Tentacle',
  role: 'tentacle',
  kind: 'cli',
  online: true,
};

function chatArea(page: Page): Locator {
  return page.locator('main');
}

async function gotoWithRelay(page: Page, server: MockRelayServer): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?relay=${encodeURIComponent(server.url)}`);
}

async function authenticateClient(
  server: MockRelayServer,
  options: { sessions?: Record<string, unknown>[]; devices?: Record<string, unknown>[] } = {},
): Promise<WebSocket> {
  const ws = await server.waitForConnection();
  await server.waitForMessage(ws);
  server.sendAuthOk(ws, {
    sessions: options.sessions,
    devices: options.devices ?? [TEST_DEVICE],
  });
  return ws;
}

// ─── Test Suite ───────────────────────────────────────────────────────

test.describe('Smart warm-up', () => {
  let server: MockRelayServer;

  test.beforeEach(async () => {
    server = await MockRelayServer.create();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test('sidebar shows preview from session_list without fetching messages', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoWithRelay(page, server);

    const now = new Date().toISOString();
    const ws = await authenticateClient(server, {
      sessions: [
        {
          id: 'sess-1',
          deviceId: DEVICE_ID,
          deviceName: 'Test Tentacle',
          agent: 'copilot',
          model: 'gpt-4',
          state: 'idle',
          messageCount: 200,
          preview: { text: 'Deployed v2 to prod', type: 'agent', timestamp: now },
        },
        {
          id: 'sess-2',
          deviceId: DEVICE_ID,
          deviceName: 'Test Tentacle',
          agent: 'copilot',
          model: 'claude-sonnet-4',
          state: 'active',
          messageCount: 50,
          preview: { text: 'Running npm test', type: 'user', timestamp: now },
        },
      ],
    });

    // Keep WS alive: drain warm-up replay requests the client sends
    ws.on('message', () => {});
    ws.on('error', () => {});

    // Both previews should appear in the session card buttons
    await expect(page.locator('button', { hasText: 'Deployed v2 to prod' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button', { hasText: 'Running npm test' }).first()).toBeVisible({ timeout: 5000 });
  });

  test('clicking a session loads messages and shows chat', async ({ page }) => {
    await gotoWithRelay(page, server);

    const now = new Date().toISOString();
    const ws = await authenticateClient(server, {
      sessions: [{
        id: 'sess-chat',
        deviceId: DEVICE_ID,
        deviceName: 'Test Tentacle',
        agent: 'copilot',
        model: 'gpt-4',
        state: 'active',
        messageCount: 10,
        preview: { text: 'Ready to help', type: 'agent', timestamp: now },
      }],
    });

    // Click session card
    const card = page.getByText('Copilot').first();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();

    // Chat area should appear
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 3000 });

    // Send a live message
    server.sendMessage(ws, {
      type: 'agent_message',
      sessionId: 'sess-chat',
      payload: { content: 'Hello! I can help with that.' },
    });

    await expect(chatArea(page).getByText('Hello! I can help with that.')).toBeVisible({ timeout: 5000 });
  });

  test('old session without preview still renders in sidebar', async ({ page }) => {
    await gotoWithRelay(page, server);

    await authenticateClient(server, {
      sessions: [{
        id: 'sess-no-preview',
        deviceId: DEVICE_ID,
        deviceName: 'Test Tentacle',
        agent: 'copilot',
        state: 'idle',
        messageCount: 500,
        // No preview field — old tentacle or empty session
      }],
    });

    // Session card should still appear even without preview
    await expect(page.getByText('Copilot').first()).toBeVisible({ timeout: 5000 });
  });
});
