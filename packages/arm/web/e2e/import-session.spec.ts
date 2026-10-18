import { test, expect, type Page } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';
import { MockTentaclePeer } from './helpers/mock-tentacle-peer';
import type { WebSocket } from 'ws';

const DEVICE_ID = 'tentacle-1';
const TEST_DEVICE = {
  id: DEVICE_ID, name: 'MacBook Pro', role: 'tentacle', kind: 'desktop', online: true,
};

const MOCK_LOCAL_SESSIONS = [
  {
    sessionId: 'abc-hermit', cwd: '/Users/test/Repos/hermit',
    gitRoot: '/Users/test/Repos/hermit', repository: 'corelli18512/hermit',
    branch: 'main', summary: 'Set Up Playwright E2E Tests',
    startTime: '2026-04-17T01:00:00Z', modifiedTime: '2026-04-17T03:55:00Z',
    isLive: true, source: 'copilot-cli',
  },
  {
    sessionId: 'def-hermit', cwd: '/Users/test/Repos/hermit',
    gitRoot: '/Users/test/Repos/hermit', repository: 'corelli18512/hermit',
    branch: 'main', summary: 'Fix auth token refresh',
    startTime: '2026-04-16T10:00:00Z', modifiedTime: '2026-04-16T12:30:00Z',
    isLive: false, source: 'copilot-cli',
  },
  {
    sessionId: 'kraki-001', cwd: '/Users/test/Repos/kraki',
    gitRoot: '/Users/test/Repos/kraki', repository: 'corelli18512/kraki',
    branch: 'main', summary: 'Debug Install Failure',
    startTime: '2026-04-17T02:00:00Z', modifiedTime: '2026-04-17T03:50:00Z',
    isLive: true, source: 'copilot-cli',
  },
  {
    sessionId: 'kraki-002', cwd: '/Users/test/Repos/kraki',
    gitRoot: '/Users/test/Repos/kraki', repository: 'corelli18512/kraki',
    branch: 'feat/sync', summary: 'Plan local session sync',
    startTime: '2026-04-17T01:30:00Z', modifiedTime: '2026-04-17T02:30:00Z',
    isLive: false, source: 'copilot-cli',
  },
  {
    sessionId: 'vscode-001', cwd: '/Users/test/Repos/Stitch',
    gitRoot: '/Users/test/Repos/Stitch', branch: 'main',
    summary: 'Resolve ADB Multiple Devices',
    startTime: '2026-04-14T10:00:00Z', modifiedTime: '2026-04-14T11:00:00Z',
    isLive: false, source: 'vscode',
  },
  {
    sessionId: 'home-001', cwd: '/Users/test',
    summary: 'Fix BlackHole Audio Routing',
    startTime: '2026-04-13T15:00:00Z', modifiedTime: '2026-04-13T16:00:00Z',
    isLive: false, source: 'copilot-cli',
  },
];

async function setup(page: Page, server: MockRelayServer): Promise<{ ws: WebSocket; peer: MockTentaclePeer }> {
  const connection = server.waitForConnection();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/?relay=${encodeURIComponent(server.url)}&token=e2e-test`);

  const ws = await connection;
  const auth = await server.waitForMessage(ws);
  expect(auth).toMatchObject({ type: 'auth', device: { encryptionKey: expect.any(String) } });
  const peer = await MockTentaclePeer.create(ws, DEVICE_ID);
  server.sendAuthOk(ws, { devices: [{ ...TEST_DEVICE, encryptionKey: peer.encryptionKey }] });
  peer.connect();

  // Seed one native session so sidebar shows session list header with import button
  server.sendMessage(ws, {
    type: 'session_list',
    payload: {
      sessions: [{
        id: 'native-1', agent: 'copilot', model: 'claude-sonnet-4',
        state: 'idle', mode: 'auto', lastSeq: 5, readSeq: 5,
        messageCount: 5, createdAt: '2026-04-17T00:00:00Z',
      }],
    },
  });

  await expect(page.getByRole('button', { name: 'New session' }).first()).toBeVisible({ timeout: 8000 });
  return { ws, peer };
}

/** Open the import dialog and answer its real encrypted scan request. */
async function openImportAndLoad(page: Page, ws: WebSocket, peer: MockTentaclePeer, server: MockRelayServer): Promise<void> {
  // Mac parity: left-click focuses the idle composer; right-click opens the + menu.
  await page.getByRole('button', { name: 'New session' }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Import Session/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 });

  expect(await peer.waitForMessage('request_local_sessions')).toMatchObject({
    payload: { targetDeviceId: DEVICE_ID },
  });
  server.sendMessage(ws, {
    type: 'local_sessions_list',
    payload: { sessions: MOCK_LOCAL_SESSIONS },
  });

  await expect(page.getByRole('dialog').getByText('hermit')).toBeVisible({ timeout: 5000 });
}

test.describe('Import Session Feature', () => {
  let server: MockRelayServer;
  test.beforeEach(async () => { server = await MockRelayServer.create(); });
  test.afterEach(async () => { await server.close(); });

  test('shows import button, opens dialog with loading, renders tree', async ({ page }) => {
    const { ws, peer } = await setup(page, server);

    // Open dialog (sidebar + menu) — shows loading
    await page.getByRole('button', { name: 'New session' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Import Session/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('dialog').getByText('Scanning local sessions')).toBeVisible({ timeout: 2000 });

    expect(await peer.waitForMessage('request_local_sessions')).toMatchObject({
      payload: { targetDeviceId: DEVICE_ID },
    });
    server.sendMessage(ws, {
      type: 'local_sessions_list',
      payload: { sessions: MOCK_LOCAL_SESSIONS },
    });

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('hermit')).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByText('kraki')).toBeVisible();
    await expect(dialog.getByText('6 local sessions')).toBeVisible();

    // Expand hermit folder
    await dialog.getByText('hermit').first().click();
    await expect(dialog.getByText('Set Up Playwright E2E Tests')).toBeVisible({ timeout: 3000 });
    await expect(dialog.getByText('Fix auth token refresh')).toBeVisible();
  });

  test('search filters sessions across folders', async ({ page }) => {
    const { ws, peer } = await setup(page, server);
    await openImportAndLoad(page, ws, peer, server);

    // Type search
    await page.getByPlaceholder('Search sessions…').fill('kraki');
    await expect(page.getByRole('dialog').getByText('2 of 6')).toBeVisible({ timeout: 3000 });
  });

  test('import session: dismisses dialog, opens pending session, then shows imported chat', async ({ page }) => {
    const { ws, peer } = await setup(page, server);
    await openImportAndLoad(page, ws, peer, server);

    // Expand hermit and click import
    await page.getByRole('dialog').getByText('hermit').first().click();
    await expect(page.getByRole('dialog').getByText('Set Up Playwright E2E Tests')).toBeVisible({ timeout: 3000 });
    await page.getByRole('dialog').getByTitle('Import session', { exact: true }).first().click();

    // Current Mac flow dismisses immediately and navigates to the pending chat.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/session\/abc-hermit/);
    await expect(page.getByText('Starting session…')).toBeVisible();
    const request = await peer.waitForMessage('import_session');
    expect(request).toMatchObject({
      payload: {
        localSessionId: 'abc-hermit',
        targetDeviceId: DEVICE_ID,
        meta: { cwd: '/Users/test/Repos/hermit', summary: 'Set Up Playwright E2E Tests' },
      },
    });

    server.sendMessage(ws, {
      type: 'session_created',
      sessionId: 'abc-hermit',
      payload: {
        requestId: (request.payload as { requestId: string }).requestId,
        agent: 'copilot', model: 'claude-sonnet-4', lastSeq: 47,
      },
    });

    await expect(page.getByText('Starting session…')).toHaveCount(0);
    await expect(page.locator('[data-chat-scroll]')).toBeVisible();
    await expect(page.locator('main').getByRole('button', { name: 'New Session', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
