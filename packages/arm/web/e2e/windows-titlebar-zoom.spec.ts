import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createServer, type ViteDevServer } from 'vite';

// Real ChatHeader/Sidebar/Composer with synthetic state, not an Electron window.
// Desktop useNarrow must stay false; the min800 body and 280px rail stay intact.
const fixture = `<!doctype html><html><head></head><body><div id="root"></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import '/src/components/chat/chat.css';
window.krakiDesktop = { platform: 'win32', titleBarOverlay: { setTheme() {} } };
const [{ ChatHeader }, { WindowsTitleBar }, { useNarrow }, { Sidebar }, { Composer }, { useStore }, { MemoryRouter }] = await Promise.all([
  import('/src/components/chat/ChatHeader.tsx'), import('/src/components/desktop/WindowsTitleBar.tsx'),
  import('/src/hooks/useNarrow.ts'), import('/src/components/layout/Sidebar.tsx'),
  import('/src/components/chat/Composer.tsx'), import('/src/hooks/useStore.ts'), import('react-router'),
]);
const params = new URLSearchParams(location.search);
const title = params.get('title') === 'short' ? 'Hi' : 'Long desktop session title '.repeat(20);
document.documentElement.style.setProperty('--windows-caption-width', params.get('caption') + 'px');
useStore.getState().setDevices([{ id: 'test-pc', name: 'Synthetic PC', role: 'tentacle', online: true }]);
useStore.getState().setSessions([{ id: 'zoom-test', deviceId: 'test-pc', agent: 'copilot', state: 'idle', title, messageCount: 1 }]);
useStore.getState().setStatus('connected');
const h = React.createElement;
function Fixture() {
  const narrow = useNarrow();
  const [mode, setMode] = React.useState(params.get('mode'));
  const [titleActions, setTitleActions] = React.useState(0);
  const [modeActions, setModeActions] = React.useState([]);
  return h(MemoryRouter, null, h('div', { className: 'app-viewport min-w-[800px] flex overflow-hidden bg-surface-primary', 'data-narrow': narrow },
    h(WindowsTitleBar),
    h('aside', { className: 'flex w-[280px] shrink-0 flex-col' }, h(Sidebar)),
    h('main', { className: 'relative flex min-w-0 flex-1 flex-col overflow-hidden app-main-wide' },
      h('div', { className: 'kchat-page' }, h('div', { className: 'kmedia-pane relative flex min-h-0 flex-1' },
        h('div', { className: 'relative flex min-w-0 flex-1' },
          h(ChatHeader, { title, mode, narrow, onTitle: () => setTitleActions(n => n + 1), onMode: m => { setMode(m); setModeActions(a => [...a, m]); } }),
          h('div', { className: 'kchat' },
            h('div', { className: 'kchat-empty', 'data-testid': 'transcript', style: { paddingTop: 56 } },
              h('output', { 'data-testid': 'title-actions' }, titleActions),
              h('output', { 'data-testid': 'mode-actions' }, modeActions.join(','))),
            h('div', { className: 'kcomposer-dock' }, h(Composer, { sessionId: 'zoom-test', intent: 'prompt', canAbort: false, reachable: true, busy: false, onSend() {}, onAbort() {} })),
          ),
        ),
      )),
    ),
  ));
}
createRoot(document.getElementById('root')).render(h(Fixture));
</script></body></html>`;

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'windows-titlebar-zoom-fixture',
      configureServer(vite) {
        vite.middlewares.use('/__windows-titlebar-zoom', async (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(await vite.transformIndexHtml('/__windows-titlebar-zoom', fixture));
        });
      },
    }],
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}__windows-titlebar-zoom`;
});
test.afterAll(async () => { await server?.close(); });

// Supervisor-approved zoom-correlated matrix, with +/-4px caption boundaries.
// Arbitrary combinations such as 463/138 are NOT established native geometry.
const matrix = [[800, 138], [677, 118], [600, 100], [463, 80]];
for (const [width, nominalCaption] of matrix) {
  const height = Math.round(560 * width / 800);
  for (const delta of [-4, 0, 4]) {
    const caption = nominalCaption + delta;
    test(`desktop-wide ${width}px / caption ${caption}px preserves title, modes and popup access`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.route('**/*', (route) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      const evidence = [];
      for (const title of ['short', 'long']) {
        for (const mode of ['safe', 'auto', 'delegate']) {
          await page.goto(`${url}?caption=${caption}&title=${title}&mode=${mode}`);
          const header = page.locator('.khead');
          const titleButton = page.locator('.khead-title');
          const trigger = page.locator('.khead-capsule');
          await expect(header).toHaveClass('khead is-wide is-windows');
          await expect(page.locator('.app-viewport')).toHaveAttribute('data-narrow', 'false');
          await expect(page.locator('.app-viewport')).toHaveCSS('min-width', '800px');
          await expect(page.locator('.app-viewport > aside')).toHaveCSS('width', '280px');
          await expect(header).toHaveCSS('height', '56px');
          const before = await page.evaluate(() => {
            const rect = (selector: string) => {
              const r = document.querySelector(selector)!.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right };
            };
            return {
              viewport: innerWidth,
              viewportHeight: innerHeight,
              caption: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--windows-caption-width')),
              shell: rect('.app-viewport'), sidebar: rect('.app-viewport > aside'),
              title: rect('.khead-title'), mode: rect('.khead-capsule'),
              transcript: rect('[data-testid="transcript"]'), composer: rect('.kcomposer-dock'),
            };
          });
          expect(before.shell.width).toBe(800);
          expect(before.sidebar.width).toBe(280);
          expect(before.title.width).toBeGreaterThanOrEqual(24);
          expect(before.title.x).toBeGreaterThanOrEqual(280);
          expect(before.title.right).toBeLessThanOrEqual(before.mode.x);
          expect(before.mode.right).toBeLessThanOrEqual(width - caption);
          // The complete current mode label remains painted, not clipped/hidden.
          expect(await trigger.textContent()).toBe(mode[0].toUpperCase() + mode.slice(1));
          expect(await trigger.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          await titleButton.click();
          await expect(page.getByTestId('title-actions')).toHaveText('1');
          await titleButton.focus();
          await page.keyboard.press('Enter');
          await expect(page.getByTestId('title-actions')).toHaveText('2');
          await page.keyboard.press('Tab');
          await expect(trigger).toBeFocused();
          await page.keyboard.press('Enter');
          const menu = page.getByRole('menu', { name: 'Session mode picker' });
          await expect(menu).toBeVisible();
          const menuBounds = (await menu.boundingBox())!;
          expect(menuBounds.x).toBeGreaterThanOrEqual(8);
          expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width - 8);
          expect(menuBounds.y).toBeGreaterThanOrEqual(44);
          expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(height - 8);
          for (const label of ['Safe', 'Auto', 'Delegate']) {
            // Trial clicks also catch clipping by the min800 main/chat panes.
            await page.getByRole('menuitemradio', { name: new RegExp(label) }).click({ trial: true });
          }
          await page.keyboard.press('Home');
          await expect(page.getByRole('menuitemradio', { name: /Safe/ })).toBeFocused();
          await expect(page.getByRole('menuitemradio', { name: /Safe/ })).toHaveCSS('outline-width', '2px');
          await page.keyboard.press('End');
          await expect(page.getByRole('menuitemradio', { name: /Delegate/ })).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(trigger).toBeFocused();
          await expect(menu).toHaveCount(0);
          for (const label of ['Safe', 'Auto', 'Delegate']) {
            await trigger.click();
            await page.getByRole('menuitemradio', { name: new RegExp(label) }).click();
            await expect(trigger).toHaveAttribute('aria-label', `Session mode, ${label}`);
            await expect(trigger).toBeFocused();
          }
          await expect(page.getByTestId('mode-actions')).toHaveText(mode === 'safe' ? 'auto,delegate' : 'safe,auto,delegate');
          const after = await page.evaluate(() => {
            const rect = (selector: string) => {
              const r = document.querySelector(selector)!.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right };
            };
            return { transcript: rect('[data-testid="transcript"]'), composer: rect('.kcomposer-dock') };
          });
          expect(after.transcript).toEqual(before.transcript);
          expect(after.composer).toEqual(before.composer);
          evidence.push({ titleKind: title, initialMode: mode, ...before, menu: menuBounds, after });
        }
      }
      const path = testInfo.outputPath('geometry.json');
      await writeFile(path, JSON.stringify(evidence, null, 2));
      await testInfo.attach('geometry', { path, contentType: 'application/json' });
    });
  }
}

test('reanchors an open wide desktop menu as viewport and caption geometry change', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 560 });
  await page.route('**/*', (route) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto(`${url}?caption=138&title=long&mode=delegate`);
  const trigger = page.locator('.khead-capsule');
  await trigger.click();
  const evidence = [];
  for (const [width, caption] of matrix) {
    const height = Math.round(560 * width / 800);
    await page.setViewportSize({ width, height });
    await page.evaluate((value) => document.documentElement.style.setProperty('--windows-caption-width', `${value}px`), caption);
    await expect.poll(() => page.evaluate(() => {
      const triggerLeft = document.querySelector('.khead-capsule')!.getBoundingClientRect().left;
      const popup = document.querySelector<HTMLElement>('.khead-windows-popup')!;
      return Math.abs(triggerLeft - parseFloat(popup.style.getPropertyValue('--windows-mode-left')));
    })).toBeLessThan(0.5);
    const menu = page.getByRole('menu');
    const rect = (await menu.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(8);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width - 8);
    expect(rect.y + rect.height).toBeLessThanOrEqual(height - 8);
    await page.getByRole('menuitemradio', { name: /Delegate/ }).click({ trial: true });
    const triggerRect = (await trigger.boundingBox())!;
    expect(triggerRect.x + triggerRect.width).toBeLessThanOrEqual(width - caption);
    evidence.push({ viewport: width, viewportHeight: height, caption, trigger: triggerRect, menu: rect });
    if (width === 600 || width === 463) await page.screenshot({ path: testInfo.outputPath(`desktop-wide-${width}.png`) });
  }
  await page.getByRole('menuitemradio', { name: /Safe/ }).click();
  await expect(trigger).toHaveAttribute('aria-label', 'Session mode, Safe');
  await expect(trigger).toBeFocused();
  const path = testInfo.outputPath('resize-geometry.json');
  await writeFile(path, JSON.stringify(evidence, null, 2));
  await testInfo.attach('resize-geometry', { path, contentType: 'application/json' });
});
