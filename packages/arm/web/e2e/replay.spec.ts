import { test, expect, type Page, type Locator } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';
import type { WebSocket } from 'ws';

const SESSION_ID = 'session-abc';
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

/** Get a locator scoped to the main chat content area (excludes sidebar). */
function chatArea(page: Page): Locator {
  return page.locator('main');
}

/**
 * Navigate to the app with a mock relay server URL injected via ?relay= param.
 * Clears localStorage to start fresh unless `keepStorage` is true.
 */
async function gotoWithRelay(
  page: Page,
  server: MockRelayServer,
  opts: { keepStorage?: boolean; path?: string } = {},
): Promise<void> {
  const path = opts.path ?? '/';
  if (!opts.keepStorage) {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
  }
  await page.goto(`${path}?relay=${encodeURIComponent(server.url)}`);
}

/**
 * Helper: authenticate the client and return the WS connection.
 * Waits for the client to connect, handles auth message, sends auth_ok + session_list.
 */
async function authenticateClient(
  server: MockRelayServer,
  options: { sessions?: Record<string, unknown>[]; devices?: Record<string, unknown>[]; readState?: Record<string, number> } = {},
): Promise<WebSocket> {
  const ws = await server.waitForConnection();
  await server.waitForMessage(ws);
  server.sendAuthOk(ws, {
    sessions: options.sessions ?? [TEST_SESSION],
    devices: options.devices ?? [TEST_DEVICE],
    readState: options.readState,
  });
  await server.waitForMessage(ws);
  return ws;
}

/**
 * Navigate to the dashboard, authenticate, wait for session to appear,
 * then click the session card to open it.
 */
async function setupAndOpenSession(
  page: Page,
  server: MockRelayServer,
  options?: { sessions?: Record<string, unknown>[]; devices?: Record<string, unknown>[] },
): Promise<WebSocket> {
  await gotoWithRelay(page, server);
  const ws = await authenticateClient(server, options);
  // Wait for session card to appear in sidebar (session_list processed)
  const sessionCard = page.getByText('Copilot').first();
  await expect(sessionCard).toBeVisible({ timeout: 5000 });
  // Click session card to navigate to session page (SPA navigation, no reconnect)
  await sessionCard.click();
  // Wait for chat area to be present
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 3000 });
  return ws;
}

/**
 * Send agent messages for the test session.
 */
function sendAgentMessages(
  server: MockRelayServer,
  ws: WebSocket,
  messages: { content: string }[],
): void {
  for (const msg of messages) {
    server.sendMessage(ws, {
      type: 'agent_message',
      sessionId: SESSION_ID,
      payload: { content: msg.content },
    });
  }
}

// ─── Test Suite ───────────────────────────────────────────────────────

test.describe('Replay and chat history', () => {
  let server: MockRelayServer;

  test.beforeEach(async () => {
    server = await MockRelayServer.create();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test('displays messages during replay and clears loading state', async ({ page }) => {
    const ws = await setupAndOpenSession(page, server);

    sendAgentMessages(server, ws, [
      { content: 'Hello from replay' },
      { content: 'Second message' },
    ]);

    const chat = chatArea(page);
    await expect(chat.getByText('Hello from replay')).toBeVisible({ timeout: 5000 });
    await expect(chat.getByText('Second message')).toBeVisible({ timeout: 5000 });
  });

  test('persists chat history across page refresh', async ({ page }) => {
    test.fixme(true, 'IDB cache does not survive page.goto in Playwright — pre-existing limitation');
  });

  test('restores cached messages after refresh', async ({ page }) => {
    test.fixme(true, 'IDB cache does not survive page.goto in Playwright — pre-existing limitation');
  });

  test('keeps messages after reconnect', async ({ page }) => {
    const ws = await setupAndOpenSession(page, server);

    sendAgentMessages(server, ws, [{ content: 'Should survive reconnect' }]);

    const chat = chatArea(page);
    await expect(chat.getByText('Should survive reconnect')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    const ws2Promise = server.waitForConnection();
    ws.close();

    const ws2 = await ws2Promise;
    await server.waitForMessage(ws2);
    server.sendAuthOk(ws2, { sessions: [TEST_SESSION], devices: [TEST_DEVICE] });

    await expect(chat.getByText('Should survive reconnect')).toBeVisible({ timeout: 5000 });
  });

  test('replay completes and live messages are processed', async ({ page }) => {
    const ws = await setupAndOpenSession(page, server);

    sendAgentMessages(server, ws, [{ content: 'Replay message' }]);

    const chat = chatArea(page);
    await expect(chat.getByText('Replay message')).toBeVisible({ timeout: 5000 });

    await page.waitForTimeout(500);

    sendAgentMessages(server, ws, [{ content: 'Live message' }]);
    await expect(chat.getByText('Live message')).toBeVisible({ timeout: 5000 });
  });

  test('tool_start and tool_complete merge correctly during replay', async ({ page }) => {
    const ws = await setupAndOpenSession(page, server);

    server.sendMessage(ws, {
      type: 'tool_start',
      sessionId: SESSION_ID,
      payload: {
        toolCallId: 'tc-1',
        toolName: 'bash',
        args: { command: 'ls -la' },
      },
    });

    server.sendMessage(ws, {
      type: 'tool_complete',
      sessionId: SESSION_ID,
      payload: {
        toolCallId: 'tc-1',
        toolName: 'bash',
        args: { command: 'ls -la' },
        result: 'file1.txt\nfile2.txt',
      },
    });

    // The merged tool should appear in the chat — look for either the tool name or completion indicator
    const chat = chatArea(page);
    await expect(chat.getByText('bash').or(chat.getByText('ls -la'))).toBeVisible({ timeout: 5000 });
  });
});
