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
 * Waits for the client to connect, handles auth message, sends auth_ok.
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
    await gotoWithRelay(page, server, { path: `/session/${SESSION_ID}` });
    const ws = await authenticateClient(server);

    sendAgentMessages(server, ws, [
      { content: 'Hello from replay' },
      { content: 'Second message' },
    ]);

    const chat = chatArea(page);
    await expect(chat.getByText('Hello from replay')).toBeVisible({ timeout: 5000 });
    await expect(chat.getByText('Second message')).toBeVisible({ timeout: 5000 });

    // After 300ms debounce, replay ends — loading indicators should be gone
    await page.waitForTimeout(500);
    await expect(page.getByTestId('replay-skeleton')).not.toBeVisible();
    await expect(page.getByTestId('replay-indicator')).not.toBeVisible();
  });

  test('persists chat history across page refresh', async ({ page }) => {
    await gotoWithRelay(page, server, { path: `/session/${SESSION_ID}` });
    const ws = await authenticateClient(server);

    sendAgentMessages(server, ws, [
      { content: 'Persistent message 1' },
      { content: 'Persistent message 2' },
    ]);

    const chat = chatArea(page);
    await expect(chat.getByText('Persistent message 1')).toBeVisible({ timeout: 5000 });
    await expect(chat.getByText('Persistent message 2')).toBeVisible({ timeout: 5000 });

    // Wait for replay to complete and state to persist
    await page.waitForTimeout(500);

    // Verify messages were persisted to localStorage
    const storedData = await page.evaluate(() => localStorage.getItem('kraki-store'));
    expect(storedData).toBeTruthy();

    // Refresh — history should appear from cache before server responds
    await page.goto(`/session/${SESSION_ID}?relay=${encodeURIComponent(server.url)}`);
    await expect(chat.getByText('Persistent message 1')).toBeVisible({ timeout: 3000 });
    await expect(chat.getByText('Persistent message 2')).toBeVisible({ timeout: 3000 });
  });

  test('restores cached messages after refresh', async ({ page }) => {
    await gotoWithRelay(page, server, { path: `/session/${SESSION_ID}` });
    const ws = await authenticateClient(server);

    sendAgentMessages(server, ws, [{ content: 'Old message' }]);

    const chat = chatArea(page);
    await expect(chat.getByText('Old message')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    // Refresh the page — client will reconnect
    await page.goto(`/session/${SESSION_ID}?relay=${encodeURIComponent(server.url)}`);

    const ws2 = await server.waitForConnection();
    await server.waitForMessage(ws2); // auth
    server.sendAuthOk(ws2, { sessions: [TEST_SESSION], devices: [TEST_DEVICE] });

    // Send only the new message
    sendAgentMessages(server, ws2, [{ content: 'New message after refresh' }]);

    // Both old (from cache) and new messages should be visible
    await expect(chat.getByText('Old message')).toBeVisible({ timeout: 3000 });
    await expect(chat.getByText('New message after refresh')).toBeVisible({ timeout: 5000 });
  });

  test('keeps messages after reconnect', async ({ page }) => {
    await gotoWithRelay(page, server, { path: `/session/${SESSION_ID}` });
    const ws = await authenticateClient(server);

    sendAgentMessages(server, ws, [{ content: 'Should survive reconnect' }]);

    const chat = chatArea(page);
    await expect(chat.getByText('Should survive reconnect')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    // Set up connection listener before closing
    const ws2Promise = server.waitForConnection();

    // Disconnect server-side
    ws.close();

    // The client reconnects after ~1s (RECONNECT_BASE)
    const ws2 = await ws2Promise;
    const authMsg = await server.waitForMessage(ws2);
    server.sendAuthOk(ws2, { sessions: [TEST_SESSION], devices: [TEST_DEVICE] });
    await server.waitForMessage(ws2);

    // Message should still be visible (cache preserved)
    await expect(chat.getByText('Should survive reconnect')).toBeVisible({ timeout: 3000 });
  });

  test('replay completes and live messages are processed', async ({ page }) => {
    await gotoWithRelay(page, server, { path: `/session/${SESSION_ID}` });
    const ws = await authenticateClient(server);

    // Send a replay message
    sendAgentMessages(server, ws, [{ content: 'Replay message' }]);

    const chat = chatArea(page);
    await expect(chat.getByText('Replay message')).toBeVisible({ timeout: 5000 });

    // Wait for replay to complete (300ms debounce + buffer)
    await page.waitForTimeout(500);

    // Send a live message (after replay ended)
    sendAgentMessages(server, ws, [{ content: 'Live message' }]);

    await expect(chat.getByText('Live message')).toBeVisible({ timeout: 5000 });
  });

  test('tool_start and tool_complete merge correctly during replay', async ({ page }) => {
    await gotoWithRelay(page, server, { path: `/session/${SESSION_ID}` });
    const ws = await authenticateClient(server);

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
        output: 'file1.txt\nfile2.txt',
      },
    });

    // Wait for replay to complete
    await page.waitForTimeout(500);

    // Verify the completed tool is shown (merged tool_complete replaced tool_start)
    const chat = chatArea(page);
    await expect(chat.getByRole('button', { name: /Completed/i })).toBeVisible({ timeout: 3000 });
  });
});
