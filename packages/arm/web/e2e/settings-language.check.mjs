// Isolated renderer check for Settings › Language (no relay/account).
// Run: node e2e/settings-language.check.mjs  (requires Playwright Chromium)
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.KRAKI_L10N_SCREENSHOTS || await mkdtemp(join(tmpdir(), 'kraki-settings-language-'));
await mkdir(output, { recursive: true });
const html = `<!doctype html><html><head></head><body><div id="root"></div><script type="module">
import '/src/index.css';
window.languageCalls = [];
if (new URLSearchParams(location.search).get('platform') === 'win32') {
  window.krakiDesktop = { platform: 'win32', version: '0.0.0-test', setLanguage: (c) => window.languageCalls.push(c),
    settings: { state: async () => ({ usageShortcut: 'F6', usageShortcutEnabled: true, launchAtLogin: false, keepRunningInTray: true, notificationPermission: 'granted' }) } };
}
await import('/src/i18n/index.ts');
const { syncDesktopLanguage } = await import('/src/i18n/desktop-bridge.ts');
syncDesktopLanguage();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { SettingsPanel } = await import('/src/components/layout/SettingsPanel.tsx');
const { useStore } = await import('/src/hooks/useStore.ts');
useStore.getState().reset();
useStore.setState({ status: 'connected', user: { id: 't', login: 'l10n-test' }, deviceId: 'self', devices: new Map(), archiveInfo: new Map() });
createRoot(document.getElementById('root')).render(React.createElement(SettingsPanel, { open: true, onClose() {} }));
</script></body></html>`;
await writeFile(join(root, 'l10n-check.html'), html);
const server = await createServer({ root, logLevel: 'error', server: { port: 0 } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  for (const [platform, locale] of [['browser', 'en-US'], ['browser', 'zh-CN'], ['win32', 'en-US']]) {
    const page = await browser.newPage({ locale, viewport: { width: 900, height: 700 } });
    await page.goto(`${url}l10n-check.html?platform=${platform}`);
    const select = page.getByTestId('settings-language');
    await select.waitFor();
    // 'System' follows the browser language.
    const expectSystem = locale.startsWith('zh') ? '语言' : 'Language';
    assert.equal(await page.locator('.kp-row span', { hasText: expectSystem }).count() > 0, true, `${platform}/${locale} system`);
    await page.screenshot({ path: join(output, `${platform}-${locale}-system.png`) });
    await select.selectOption('zh-Hans');
    await page.locator('.kp-row span', { hasText: '语言' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hans');
    assert.equal(await page.evaluate(() => localStorage.getItem('kraki-language')), 'zh-Hans');
    await page.screenshot({ path: join(output, `${platform}-${locale}-zh.png`) });
    if (platform === 'win32') assert.deepEqual(await page.evaluate(() => window.languageCalls), ['en', 'zh-Hans']);
    // Back to system: preference cleared, language follows the browser again.
    await select.selectOption('system');
    await page.locator('.kp-row span', { hasText: expectSystem }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('kraki-language')), null);
    // Survives a reload.
    await select.selectOption('zh-Hans');
    await page.reload();
    await page.locator('.kp-row span', { hasText: '语言' }).waitFor();
    await page.close();
  }
  console.log(`settings language checks passed; screenshots in ${output}`);
} finally {
  await browser.close();
  await server.close();
  const { rm } = await import('node:fs/promises');
  await rm(join(root, 'l10n-check.html'), { force: true });
}
