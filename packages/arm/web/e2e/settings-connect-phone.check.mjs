// Real SettingsPanel + sibling ConnectPhoneHost; mock only external services.
// Run explicitly with node e2e/settings-connect-phone.check.mjs (Playwright Chromium).
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.KRAKI_SETTINGS_PAIRING_EVIDENCE || await mkdtemp(join(tmpdir(), 'kraki-settings-pairing-'));
await mkdir(output, { recursive: true });
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import '/src/index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
const params = new URLSearchParams(location.search);
window.fixture = { responses: [], requests: 0, settingsClosed: 0, copied: [] };
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (text) => { window.fixture.copied.push(text); },
} });
window.krakiDesktop = {
  platform: params.get('platform'), version: '0.0.0-test',
  builtIn: {
    state: async () => ({ deviceId: 'pc' }),
    credentials: () => null,
    connectPhone: async () => {
      window.fixture.requests++;
      const next = window.fixture.responses.shift();
      if (next === 'pending') return new Promise((resolve) => { window.fixture.resolve = resolve; });
      return next || { ok: true, url: 'https://example.invalid/disposable-pairing-test' };
    },
  },
};
localStorage.setItem('kraki-theme', params.get('theme'));
const { SettingsPanel } = await import('/src/components/layout/SettingsPanel.tsx');
const { ConnectPhoneHost } = await import('/src/components/devices/ConnectPhoneCard.tsx');
const { useStore } = await import('/src/hooks/useStore.ts');
useStore.getState().reset();
useStore.setState({ status: 'connected', deviceId: 'self', user: { id: 'test', login: 'settings-test', provider: 'open' } });
window.fixture.joinPhone = () => useStore.getState().setDevices([{ id: 'phone', name: 'Test phone', role: 'app', online: true }]);
function SettingsAndPairing() {
  const [open, setOpen] = React.useState(true);
  return React.createElement(React.Fragment, null,
    React.createElement(SettingsPanel, { open, onClose: () => { window.fixture.settingsClosed++; setOpen(false); } }),
    React.createElement(ConnectPhoneHost));
}
createRoot(document.getElementById('root')).render(React.createElement(SettingsAndPairing));
</script></body></html>`;
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'settings-pairing-ownership-check',
    configureServer(server) {
      server.middlewares.use('/__settings-pairing-test', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/__settings-pairing-test', html));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  const results = [];
  for (const [platform, theme, width, height] of [
    ['win32', 'light', 1240, 900], ['win32', 'dark', 1240, 900],
    ['win32', 'light', 360, 500], ['linux', 'light', 1240, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(server.resolvedUrls.local[0] + '__settings-pairing-test?' + new URLSearchParams({ platform, theme }));
    await page.getByRole('tab', { name: 'Devices', exact: true }).click();
    const opener = page.getByRole('button', { name: 'Show Code…', exact: true });
    const pairing = page.getByRole('dialog', { name: 'Connect your phone' });
    const close = pairing.getByRole('button', { name: 'Close', exact: true });
    const copy = pairing.getByRole('button', { name: 'Copy link', exact: true });
    const retry = pairing.getByRole('button', { name: 'Try again', exact: true });
    const history = [];
    const recordFocus = async (step) => {
      history.push({ step, ...await page.evaluate(() => ({
        text: document.activeElement?.textContent,
        label: document.activeElement?.getAttribute('aria-label'),
        dialog: document.activeElement?.closest('[role=dialog]')?.getAttribute('aria-label'),
      })) });
    };
    const open = async () => { await opener.focus(); await page.keyboard.press('Enter'); await expect(close).toBeFocused(); };
    const restored = async (step) => {
      await expect(pairing).toBeHidden();
      await expect(opener).toBeFocused();
      await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => window.fixture.settingsClosed), 0);
      await recordFocus(step);
    };
    const screenshot = async (step) => page.screenshot({ path: join(output, platform + '-' + theme + '-' + width + '-' + step + '.png') });

    // Loading contains both native Tab directions, and cannot leave focus behind Settings.
    await page.evaluate(() => window.fixture.responses.push('pending', 'pending'));
    await open();
    await expect(copy).toBeDisabled();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();
    await opener.evaluate((element) => element.focus());
    await expect(close).toBeFocused();
    await recordFocus('loading-contained');
    await screenshot('loading');

    // A returned error makes Retry reachable; retry removes that focused control.
    await page.evaluate(() => window.fixture.resolve({ ok: false, error: 'daemon_not_running' }));
    await expect(retry).toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(retry).toBeFocused();
    await recordFocus('error-retry-reachable');
    await screenshot('error');
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(retry).toBeHidden();
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await recordFocus('retry-loading-contained');
    await page.evaluate(() => window.fixture.resolve({ ok: true, url: 'https://example.invalid/disposable-pairing-test' }));
    await expect(copy).toBeEnabled();
    await page.keyboard.press('Tab');
    await expect(copy).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(copy).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pairing.getByRole('button', { name: 'Copied', exact: true })).toBeFocused();
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), ['https://example.invalid/disposable-pairing-test']);
    await recordFocus('copy-reachable');
    await screenshot('copied');
    await page.keyboard.press('Escape');
    await restored('success-escape-restored');

    // Close button, error Escape, loading Escape and backdrop each leave Settings open.
    await open();
    await close.press('Enter');
    await restored('close-button-restored');
    await open();
    await close.click();
    await restored('mouse-close-restored');
    await page.evaluate(() => window.fixture.responses.push({ ok: false, error: 'offline' }));
    await open();
    await expect(retry).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(retry).toBeFocused();
    await page.keyboard.press('Escape');
    await restored('error-escape-restored');
    await page.evaluate(() => window.fixture.responses.push('pending'));
    await open();
    await expect(copy).toBeDisabled();
    await page.keyboard.press('Escape');
    await restored('loading-escape-restored');
    await page.evaluate(() => window.fixture.resolve({ ok: true, url: 'https://example.invalid/disposable-pairing-test' }));
    await expect(pairing).toBeHidden();
    await open();
    await page.locator('.cp-backdrop').click({ position: { x: 1, y: 1 } });
    await restored('backdrop-restored');

    // Pairing success removes Copy, retains Close, then auto-restores the opener.
    await open();
    await expect(copy).toBeEnabled();
    await page.keyboard.press('Tab');
    await expect(copy).toBeFocused();
    await page.evaluate(() => window.fixture.joinPhone());
    await expect(pairing.getByText('Connected', { exact: true })).toBeVisible();
    await expect(close).toBeFocused();
    await recordFocus('connected-contained');
    await screenshot('connected');
    await restored('auto-close-restored');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden();
    assert.equal(await page.evaluate(() => window.fixture.settingsClosed), 1);
    results.push({ platform, theme, width, height, history, requests: await page.evaluate(() => window.fixture.requests) });
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'settings-pairing-focus.json'), JSON.stringify({ results, errors }, null, 2));
  console.log('Passed combined Settings/ConnectPhoneHost keyboard, retry and close checks in ' + results.length + ' renderer cases; evidence: ' + output);
} finally {
  await browser?.close();
  await server.close();
}
