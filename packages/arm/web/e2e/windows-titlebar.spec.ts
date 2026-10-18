import { test, expect } from '@playwright/test';

// Chromium CSS/layout fixtures using the app's built styles. This intentionally
// does NOT claim to exercise Electron, native caption hit testing, Snap or DPI.
const shell = (content: string, sidebar = true) => `<div class="app-viewport flex overflow-hidden bg-surface-primary">
  <div class="kwindows-titlebar" aria-hidden="true"></div>
  ${sidebar ? '<aside class="w-[280px] shrink-0"><button>Sidebar</button></aside>' : ''}
  <main class="relative flex min-w-0 flex-1 flex-col overflow-hidden">${content}</main></div>`;
const header = `<header class="khead is-wide is-windows">
  <button class="khead-title"><span>${'Long session title '.repeat(20)}</span></button>
  <span class="khead-separator" aria-hidden="true"></span>
  <div class="khead-mode"><button class="khead-capsule"><span class="khead-dot"></span>Auto<svg class="khead-chevron"></svg></button></div>
</header>`;
const chat = `<div class="kchat-page"><div class="kmedia-pane relative flex min-h-0 flex-1">
  <div class="relative flex min-w-0 flex-1">${header}<div class="kchat">Transcript and composer</div></div></div></div>`;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 795 });
  // No account, relay or desktop bridge is used by these style-only fixtures.
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).waitFor();
  await page.evaluate(() => { document.documentElement.dataset.windowsTitlebar = ''; });
});

for (const width of [1240, 800]) {
  test(`keeps title/mode left, native space right and drag exclusions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 795 });
    await page.evaluate((html) => { document.getElementById('root')!.innerHTML = html; }, shell(chat));
    await expect(page.locator('.khead')).toHaveCSS('height', '56px');
    await expect(page.locator('.khead')).toHaveCSS('-webkit-app-region', 'drag');
    await expect(page.locator('.khead-title')).toHaveCSS('-webkit-app-region', 'no-drag');
    await expect(page.locator('.khead-title')).toHaveCSS('border-radius', '4px');
    await expect(page.locator('.khead-title')).toHaveCSS('box-shadow', 'none');
    await expect(page.locator('.khead-title')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('.kwindows-titlebar')).toBeHidden();
    const title = (await page.locator('.khead-title').boundingBox())!;
    const mode = (await page.locator('.khead-mode').boundingBox())!;
    expect(title.x).toBe(294);
    expect(title.width).toBeGreaterThan(0);
    expect(mode.x).toBeGreaterThan(title.x + title.width);
    expect(mode.x + mode.width).toBeLessThanOrEqual(width - 138 - 32);
    await page.evaluate(() => {
      const rect = document.querySelector('.khead-capsule')!.getBoundingClientRect();
      const popup = document.createElement('div');
      popup.className = 'kchat-page khead-windows-popup';
      popup.style.setProperty('--windows-mode-left', `${rect.left}px`);
      popup.style.setProperty('--windows-mode-top', `${rect.bottom + 6}px`);
      popup.innerHTML = '<div class="khead-menu" role="menu"><button>Safe</button><button>Auto</button><button>Delegate</button></div>';
      document.querySelector('.app-viewport')!.append(popup);
    });
    const menu = (await page.locator('.khead-menu').boundingBox())!;
    expect(menu.y).toBeGreaterThanOrEqual(44);
    expect(menu.x + menu.width).toBeLessThanOrEqual(width);
    await expect(page.locator('.khead')).toHaveCSS('height', '56px');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(page.locator('.khead-title')).toHaveCSS('box-shadow', 'none');
    await expect(page.locator('.khead-title')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });
}

test('reserves a drag strip on home/setup and keeps settings and Session Info below caption space', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 });
  await page.evaluate((html) => { document.getElementById('root')!.innerHTML = html; }, shell('<button>Home action</button>'));
  await expect(page.locator('main')).toHaveCSS('padding-top', '44px');
  expect((await page.locator('.kwindows-titlebar').boundingBox())!.x).toBe(280);
  await page.evaluate((html) => { document.getElementById('root')!.innerHTML = html; }, shell('<button>Setup action</button>', false));
  expect((await page.locator('.kwindows-titlebar').boundingBox())!.x).toBe(0);
  await page.evaluate(() => {
    document.getElementById('root')!.insertAdjacentHTML('beforeend', '<div class="kp-window" role="dialog"><button class="kp-close">Settings close</button></div>');
  });
  await expect(page.locator('[role="dialog"]')).toHaveCSS('-webkit-app-region', 'no-drag');
  const settings = (await page.locator('.kp-window').boundingBox())!;
  expect(settings.y).toBeGreaterThanOrEqual(44);
  expect(settings.y + settings.height).toBeLessThanOrEqual(560 - 44);
  await page.evaluate(() => {
    document.querySelector('.kp-window')!.remove();
    document.getElementById('root')!.insertAdjacentHTML('beforeend', '<div class="fixed inset-0 z-50" role="dialog"><div class="ksi-sheet"><button>Session Info close</button></div></div>');
  });
  expect((await page.locator('.ksi-sheet').boundingBox())!.y).toBeGreaterThanOrEqual(44);
});

test('protects report and image preview controls from the native upper-right rectangle', async ({ page }) => {
  await page.evaluate((html) => { document.getElementById('root')!.innerHTML = html; }, shell(chat));
  await page.evaluate(() => {
    document.querySelector('.kmedia-pane')!.insertAdjacentHTML('beforeend', '<aside class="kreport-panel is-expanded"><div class="kreport-header"><button>Report close</button></div></aside>');
  });
  expect((await page.getByRole('button', { name: 'Report close' }).boundingBox())!.y).toBeGreaterThanOrEqual(44);
  await page.evaluate(() => {
    document.querySelector('.kreport-panel')!.remove();
    document.querySelector('.kmedia-pane')!.insertAdjacentHTML('beforeend', '<div class="kimage-viewer" role="dialog"><div class="kimage-toolbar"><span class="kimage-spacer"></span><button>Image close</button></div></div>');
  });
  const imageClose = (await page.getByRole('button', { name: 'Image close' }).boundingBox())!;
  expect(imageClose.x + imageClose.width).toBeLessThanOrEqual(1240 - 138);
  await expect(page.locator('.kimage-viewer')).toHaveCSS('-webkit-app-region', 'no-drag');
});
