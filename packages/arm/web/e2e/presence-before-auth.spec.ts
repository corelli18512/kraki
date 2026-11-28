import { test, expect } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';

// A reload shows the persisted session list before the relay answers. Until
// this page load's auth_ok nobody's presence is known: a hollow ring, never
// the gray "offline" dot. Screenshots: KRAKI_SHOT_DIR=<dir>.
const shotDir = process.env.KRAKI_SHOT_DIR;

const studio = { id: 'studio', name: 'Studio Mac', role: 'tentacle', kind: 'desktop', online: true };
const build = { id: 'build', name: 'Build Box', role: 'tentacle', kind: 'desktop', online: false };
const sessions = [
  { id: 's-release', title: 'Release train', deviceId: 'studio', deviceName: 'Studio Mac', agent: 'claude', model: 'claude-sonnet-4', state: 'idle' },
  { id: 's-windows', title: 'Windows settings polish', deviceId: 'build', deviceName: 'Build Box', agent: 'claude', model: 'claude-sonnet-4', state: 'idle' },
];

test.describe('presence before auth', () => {
  test.use({ deviceScaleFactor: 2 });
  let server: MockRelayServer;
  test.beforeEach(async () => { server = await MockRelayServer.create(); });
  test.afterEach(async () => { await server.close(); });

  for (const scheme of ['light', 'dark'] as const) {
    test(`session rows: hollow ring until auth_ok, then online/offline (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 640 });
      // Listen for the auth frame as soon as the socket opens (before goto returns).
      const paired = server.waitForConnection().then(async (socket) => { await server.waitForMessage(socket); return socket; });
      await page.goto(`/?relay=${encodeURIComponent(server.url)}&token=e2e-test`);
      let ws = await paired;
      server.sendAuthOk(ws, { devices: [studio, build], sessions: [sessions[0]] });
      server.sendMessage(ws, { type: 'session_list', deviceId: 'build', payload: { sessions: [{ mode: 'auto', lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: new Date().toISOString(), ...sessions[1] }] } });
      const rows = page.locator('.ksr');
      await expect(rows).toHaveCount(2, { timeout: 10_000 });
      await expect(page.locator('.ksr-devdot.is-online')).toHaveCount(1);

      // Reload: the persisted list is shown; the relay does not answer yet.
      const reconnected = server.waitForConnection();
      await page.reload();
      ws = await reconnected;
      await expect(rows).toHaveCount(2);
      const dots = page.locator('.ksr-devdot');
      await expect(page.locator('.ksr-devdot.is-unknown')).toHaveCount(2);
      await expect(page.getByRole('img', { name: 'Status unknown' })).toHaveCount(2);
      await expect(page.locator('.ksr-offline')).toHaveCount(0);
      if (shotDir) await page.screenshot({ path: `${shotDir}/web-1-before-auth-${scheme}.png` });

      server.sendAuthOk(ws, { devices: [studio, build] });
      await expect(page.locator('.ksr-devdot.is-unknown')).toHaveCount(0);
      await expect(page.locator('.ksr-devdot.is-online')).toHaveCount(1);
      await expect(dots).toHaveCount(2);
      await expect(page.locator('.ksr-offline')).toHaveCount(1);
      if (shotDir) await page.screenshot({ path: `${shotDir}/web-2-after-auth-${scheme}.png` });
    });
  }
});
