// Isolated renderer checks: no relay, Electron process, CLI, or real account.
// Run explicitly with node e2e/settings-layout.check.mjs (requires Playwright Chromium).
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.KRAKI_SETTINGS_SCREENSHOTS || await mkdtemp(join(tmpdir(), 'kraki-settings-layout-'));
await mkdir(output, { recursive: true });
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import '/src/index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
window.calls = [];
const params = new URLSearchParams(location.search);
if (params.get('platform') !== 'browser') {
  window.krakiDesktop = {
    platform: params.get('platform') || 'win32', version: '0.0.0-test',
    settings: {
      state: async () => ({ usageShortcut: 'F6', usageShortcutEnabled: true, launchAtLogin: false,
        keepRunningInTray: true, notificationPermission: 'granted', logsPath: null, allowRemoteUpdates: false }),
      setLaunchAtLogin: async (on) => { window.calls.push(['login', on]); return { ok: true }; },
      setKeepRunningInTray: async (on) => { window.calls.push(['tray', on]); return { ok: true }; },
      openNotificationSettings: () => window.calls.push(['notification-settings']),
    },
    builtIn: {
      state: async () => ({ available: true, version: '0.0.0-test', configured: true, signedIn: true,
        deviceName: 'Test PC', deviceId: 'pc', relay: 'ws://localhost', owned: false, running: false,
        relayState: null, cliDaemon: false, cliLogin: false }),
      credentials: () => null,
    },
  };
}
localStorage.setItem('kraki-theme', params.get('theme') || 'light');
const { SettingsPanel } = await import('/src/components/layout/SettingsPanel.tsx');
const { useStore } = await import('/src/hooks/useStore.ts');
const { wsClient } = await import('/src/lib/ws-client.ts');
for (const method of ['updatePreferences', 'setAutoArchiveDays', 'removeDevice', 'requestAccountDeletion']) {
  wsClient[method] = (...args) => window.calls.push([method, ...args]);
}
useStore.getState().reset();
useStore.setState({
  status: 'connected', user: { id: 'test', login: 'settings-test', provider: 'open' }, deviceId: 'self',
  archiveInfo: new Map([['pc', { count: 0, days: 14 }]]),
  devices: new Map([
    ['self', { id: 'self', name: 'Test app', role: 'app', online: true }],
    ['pc', { id: 'pc', name: 'Test PC', role: 'tentacle', online: false }],
    ['old', { id: 'old', name: 'Offline test phone', role: 'app', online: false }],
  ]),
  deviceVersions: new Map([['pc', '0.0.0-test']]),
});
const settings = React.createElement(SettingsPanel, {
  open: true, inline: params.has('inline'), onClose: () => window.calls.push(['close']),
});
const mount = params.has('inline')
  ? React.createElement('div', { style: { width: params.get('inline') + 'px', height: '580px' } }, settings)
  : settings;
createRoot(document.getElementById('root')).render(mount);
</script></body></html>`;

const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'settings-visual-harness',
    configureServer(server) {
      server.middlewares.use('/__settings-test', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/__settings-test', html));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  const results = [];
  const cases = [
    [1440, 960, 'light', 'win32'], [1440, 960, 'dark', 'win32'], [800, 600, 'light', 'win32'],
    [600, 900, 'light', 'win32'], [360, 500, 'dark', 'win32'], [1440, 960, 'light', 'win32', 340],
    [900, 700, 'light', 'browser'], [900, 700, 'dark', 'linux'],
  ];
  for (const [width, height, theme, platform, inline] of cases) {
    await page.setViewportSize({ width, height });
    const query = new URLSearchParams({ theme, platform, ...(inline ? { inline: String(inline) } : {}) });
    await page.goto(base + '__settings-test?' + query);
    const panel = page.getByTestId('settings-window');
    await panel.waitFor();
    await page.getByRole('switch', { name: 'Open Kraki at login' })
      .waitFor({ state: platform === 'browser' ? 'hidden' : 'visible' });
    const windows = platform === 'win32';
    assert.equal(await panel.evaluate((element) => element.classList.contains('kp-windows')), windows);
    for (const tab of ['General', 'Account', 'Voice Input', 'Notifications', 'This PC', 'Devices', 'About']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const geometry = await panel.evaluate((element) => {
        const pane = element.querySelector('.kp-pane');
        const navigation = element.querySelector('.kp-navigation');
        const themeGrid = element.querySelector('.kp-theme-grid');
        const rect = element.getBoundingClientRect();
        return {
          radius: getComputedStyle(element).borderRadius,
          display: getComputedStyle(element).display,
          x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
          scrollWidth: pane.scrollWidth, clientWidth: pane.clientWidth,
          navigationWidth: navigation?.getBoundingClientRect().width,
          paneX: pane.getBoundingClientRect().x,
          themeColumns: themeGrid ? getComputedStyle(themeGrid).gridTemplateColumns.split(' ').length : undefined,
        };
      });
      assert(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= width + 1 && geometry.bottom <= height + 1,
        JSON.stringify(geometry));
      assert(geometry.scrollWidth <= geometry.clientWidth + 1, tab + ' horizontal overflow ' + JSON.stringify(geometry));
      if (windows) {
        assert.equal(geometry.display, 'grid');
        assert.notEqual(geometry.radius, '0px');
        if (width <= 620 || inline) assert.equal(geometry.navigationWidth, 65);
        if (inline) assert(geometry.bottom <= 580, 'Inline Settings must fit its parent');
        if (tab === 'General' && (width <= 420 || inline <= 420)) assert.equal(geometry.themeColumns, 1);
      } else {
        assert.equal(geometry.display, 'flex');
        assert.equal(geometry.right - geometry.x, 540);
        assert.equal(geometry.bottom - geometry.y, 508);
        assert.equal(geometry.navigationWidth, undefined);
      }
      const name = platform + '-' + width + 'x' + height + '-' + theme + (inline ? '-inline' : '') + '-' + tab.replaceAll(' ', '-');
      await page.screenshot({ path: join(output, name + '.png') });
      results.push({ width, height, theme, platform, inline, tab, ...geometry });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'checks.json'), JSON.stringify(results, null, 2));
  console.log('Passed ' + results.length + ' viewport/theme/platform/tab geometry checks; screenshots and checks.json: ' + output);
} finally {
  await browser?.close();
  await server.close();
}
