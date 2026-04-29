import { test, expect, type Page, type Locator } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';
import type { WebSocket } from 'ws';

const SESSION_ID = 'session-features';
const DEVICE_ID = 'tentacle-1';

const TEST_SESSION = {
  id: SESSION_ID,
  deviceId: DEVICE_ID,
  deviceName: 'Test Tentacle',
  agent: 'copilot',
  model: 'gpt-4',
  state: 'active',
  messageCount: 0,
};

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

async function gotoWithRelay(
  page: Page,
  server: MockRelayServer,
  opts: { path?: string } = {},
): Promise<void> {
  const path = opts.path ?? '/';
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${path}?relay=${encodeURIComponent(server.url)}`);
}

async function authenticateClient(
  server: MockRelayServer,
): Promise<WebSocket> {
  const ws = await server.waitForConnection();
  await server.waitForMessage(ws);
  server.sendAuthOk(ws, {
    sessions: [TEST_SESSION],
    devices: [TEST_DEVICE],
  });
  await server.waitForMessage(ws);
  return ws;
}

async function setupAndOpenSession(
  page: Page,
  server: MockRelayServer,
): Promise<WebSocket> {
  await gotoWithRelay(page, server);
  const ws = await authenticateClient(server);
  const sessionCard = page.getByText('Copilot').first();
  await expect(sessionCard).toBeVisible({ timeout: 5000 });
  await sessionCard.click();
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 3000 });
  return ws;
}

// ─── Test Suite ───────────────────────────────────────────────────────

test.describe('Feature fixes', () => {
  let server: MockRelayServer;

  test.beforeEach(async () => {
    server = await MockRelayServer.create();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test('#41: URLs in agent messages render as clickable links', async ({ page }) => {
    const ws = await setupAndOpenSession(page, server);

    server.sendMessage(ws, {
      type: 'agent_message',
      sessionId: SESSION_ID,
      payload: { content: 'Check out https://github.com/corelli18512/kraki for details' },
    });

    const link = chatArea(page).locator('a[href="https://github.com/corelli18512/kraki"]');
    await expect(link).toBeVisible({ timeout: 5000 });
  });

  test('#17: multiple permissions render stacked, not blocking each other', async ({ page }) => {
    const ws = await setupAndOpenSession(page, server);

    server.sendMessage(ws, {
      type: 'permission',
      sessionId: SESSION_ID,
      payload: {
        id: 'perm-1',
        toolName: 'shell',
        args: { command: 'npm test' },
        description: 'Run tests',
      },
    });

    server.sendMessage(ws, {
      type: 'permission',
      sessionId: SESSION_ID,
      payload: {
        id: 'perm-2',
        toolName: 'write_file',
        args: { path: '/tmp/test.txt' },
        description: 'Write file',
      },
    });

    await expect(chatArea(page).getByText('Run tests')).toBeVisible({ timeout: 5000 });
    await expect(chatArea(page).getByText('Write file')).toBeVisible({ timeout: 5000 });

    const approveButtons = chatArea(page).getByRole('button', { name: 'Approve' });
    await expect(approveButtons).toHaveCount(2);
  });
});
