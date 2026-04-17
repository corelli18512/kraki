import { test, expect, type Page } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';
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

async function setup(page: Page, server: MockRelayServer): Promise<WebSocket> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?relay=${encodeURIComponent(server.url)}`);

  const ws = await server.waitForConnection();
  await server.waitForMessage(ws);
  server.sendAuthOk(ws, { devices: [TEST_DEVICE] } as Record<string, unknown>);
  await server.waitForMessage(ws);

  // Seed one native session so sidebar shows session list header with import button
  server.sendMessage(ws, {
    type: 'session_list',
    payload: {
      sessions: [{
        id: 'native-1', agent: 'copilot', model: 'claude-sonnet-4',
        state: 'idle', mode: 'discuss', lastSeq: 5, readSeq: 5,
        messageCount: 5, createdAt: '2026-04-17T00:00:00Z',
      }],
    },
  });

  await expect(page.locator('button[title="Import local session"]').first()).toBeVisible({ timeout: 8000 });
  return ws;
}

/**
 * Open the import dialog and push sessions from the server.
 *
 * The client sends request_local_sessions encrypted (which the mock relay
 * can't decode), so we push local_sessions_list proactively after a
 * short delay to simulate the tentacle responding.
 */
async function openImportAndLoad(page: Page, ws: WebSocket, server: MockRelayServer): Promise<void> {
  await page.locator('button[title="Import local session"]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 });

  // Push sessions from server (simulates tentacle response)
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
    const ws = await setup(page, server);

    // Screenshot 1: session list with import button visible
    await page.screenshot({ path: 'e2e-1-session-list.png' });

    // Open dialog — shows loading
    await page.locator('button[title="Import local session"]').first().click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('dialog').getByText('Scanning local sessions')).toBeVisible({ timeout: 2000 });

    // Screenshot 2: loading state
    await page.screenshot({ path: 'e2e-2-import-loading.png' });

    // Push sessions from server
    server.sendMessage(ws, {
      type: 'local_sessions_list',
      payload: { sessions: MOCK_LOCAL_SESSIONS },
    });

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('hermit')).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByText('kraki')).toBeVisible();
    await expect(dialog.getByText('6 local sessions')).toBeVisible();

    // Screenshot 3: tree view with folder groups
    await page.screenshot({ path: 'e2e-3-import-tree.png' });

    // Expand hermit folder
    await dialog.getByText('hermit').first().click();
    await expect(dialog.getByText('Set Up Playwright E2E Tests')).toBeVisible({ timeout: 3000 });
    await expect(dialog.getByText('Fix auth token refresh')).toBeVisible();

    // Screenshot 4: expanded folder with sessions
    await page.screenshot({ path: 'e2e-4-expanded-folder.png' });
  });

  test('search filters sessions across folders', async ({ page }) => {
    const ws = await setup(page, server);
    await openImportAndLoad(page, ws, server);

    // Type search
    await page.getByPlaceholder('Search sessions…').fill('kraki');
    await expect(page.getByRole('dialog').getByText('2 of 6')).toBeVisible({ timeout: 3000 });

    // Screenshot 5: filtered results
    await page.screenshot({ path: 'e2e-5-search-filtered.png' });
  });

  test('import session: spinner then success', async ({ page }) => {
    const ws = await setup(page, server);
    await openImportAndLoad(page, ws, server);

    // Expand hermit and click import
    await page.getByRole('dialog').getByText('hermit').first().click();
    await expect(page.getByRole('dialog').getByText('Set Up Playwright E2E Tests')).toBeVisible({ timeout: 3000 });
    await page.getByRole('dialog').locator('button[title="Import session"]').first().click();

    // Screenshot 6: spinner on import button
    await page.screenshot({ path: 'e2e-6-import-spinner.png' });

    // Simulate session_created from tentacle (broadcast, no encryption)
    server.sendMessage(ws, {
      type: 'session_created',
      sessionId: 'abc-hermit',
      payload: { agent: 'copilot', model: 'claude-sonnet-4', lastSeq: 47 },
    });

    // Wait for session to appear in store → checkmark replaces spinner
    await page.waitForTimeout(600);

    // Screenshot 7: checkmark on imported session
    await page.screenshot({ path: 'e2e-7-import-success.png' });

    // Close dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Screenshot 8: imported session visible in sidebar
    await page.screenshot({ path: 'e2e-8-imported-in-list.png' });
  });
});
