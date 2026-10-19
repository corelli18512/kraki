import { test, expect } from '@playwright/test';

// Real Chromium resolves the media CSS variables, hover and keyboard focus;
// jsdom cannot validate these native-material paint regressions.
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 795 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).waitFor();
  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
    document.getElementById('root')!.innerHTML = `
      <div class="kchat">
        <div class="kmd"><a href="#">Ordinary transcript link</a></div>
        <div class="ksheet">
          <button class="ksheet-close">Close</button>
          <button class="ksheet-back">Steps</button>
          <button class="ksub-card"><span class="ksub-name">Name</span></button>
          <p class="ksub-page-task">Task</p><div class="ksub-report">Report</div>
          <div class="ktool-detail"><pre>Result</pre></div>
        </div>
        <button class="kreport-card"><span class="kreport-card-icon">Icon</span>
          <span class="kreport-card-text"><strong>Title</strong><small>Detail</small></span>
          <span class="kreport-card-chevron">Arrow</span></button>
        <div class="kreport-header"><span class="kreport-header-icon">Icon</span>
          <span class="kreport-header-text"><strong>Title</strong></span><button>Open</button></div>
        <div class="kreport-state"><strong>Error title</strong></div>
        <div class="kimage-toolbar" style="position:relative"><button disabled>Previous</button><button>Next</button></div>
      </div>`;
  });
});

test('uses native dark Steps/subagent surfaces and keyboard focus without recoloring ordinary links', async ({ page }) => {
  await expect(page.locator('.ktool-detail')).toHaveCSS('background-color', 'rgb(14, 18, 34)');
  await expect(page.locator('.ktool-detail pre')).toHaveCSS('max-height', '240px');
  await expect(page.locator('.ksheet-back')).toHaveCSS('color', 'rgb(94, 160, 215)');
  await expect(page.locator('.kmd a')).toHaveCSS('color', 'rgb(143, 213, 255)');
  await expect(page.locator('.ksub-report')).toHaveCSS('border-top-color', 'rgba(255, 255, 255, 0.1)');
  for (const selector of ['.ksub-name', '.ksub-page-task']) {
    await expect(page.locator(selector)).toHaveCSS('color', 'rgb(219, 232, 244)');
  }
  await page.locator('.ksub-card').hover();
  await expect(page.locator('.ksub-card')).toHaveCSS('background-color', 'rgb(2, 6, 23)');
  await page.keyboard.press('Tab');
  await page.locator('.ksheet-close').focus();
  await expect(page.locator('.ksheet-close')).toHaveCSS('outline-color', 'rgb(14, 88, 138)');
  await expect(page.locator('.ksheet-close')).toHaveCSS('outline-width', '3px');
  await expect(page.locator('.ksheet-close')).toHaveCSS('border-radius', '2px');
  await page.evaluate(() => {
    const backdrop = document.createElement('div');
    backdrop.className = 'ksheet-backdrop';
    document.body.append(backdrop);
  });
  await expect(page.locator('.ksheet-backdrop')).toHaveCSS('background-color', 'rgba(22, 23, 23, 0.6)');
  await expect(page.locator('.ksheet-backdrop')).toHaveCSS('backdrop-filter', 'none');
});

test('separates report label roles from title roles and preserves disabled image button backing', async ({ page }) => {
  await expect(page.locator('.kreport-card-text strong')).toHaveCSS('color', 'rgba(255, 255, 255, 0.847)');
  await expect(page.locator('.kreport-card-text small')).toHaveCSS('color', 'rgba(255, 255, 255, 0.55)');
  await expect(page.locator('.kreport-card-chevron')).toHaveCSS('color', 'rgba(255, 255, 255, 0.247)');
  for (const selector of ['.kreport-header-text strong', '.kreport-state strong']) {
    await expect(page.locator(selector)).toHaveCSS('color', 'rgb(219, 232, 244)');
  }
  for (const selector of ['.kreport-card-icon', '.kreport-header-icon']) {
    await expect(page.locator(selector)).toHaveCSS('color', 'rgb(0, 122, 255)');
  }
  await page.locator('.kreport-header button').hover();
  await expect(page.locator('.kreport-header button')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.locator('.kreport-card').hover();
  await expect(page.locator('.kreport-card')).toHaveCSS('background-color', 'rgba(10, 132, 255, 0.09)');
  await expect(page.locator('.kimage-toolbar')).toHaveCSS('background-color', 'rgb(22, 25, 26)');
  await expect(page.locator('.kimage-toolbar button:disabled')).toHaveCSS('opacity', '1');
  await expect(page.locator('.kimage-toolbar button:disabled')).toHaveCSS('color', 'rgba(255, 255, 255, 0.45)');
  await expect(page.locator('.kimage-toolbar button:disabled')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.1)');
});

test('retains the light media palette and disabled-button treatment', async ({ page }) => {
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await expect(page.locator('.ktool-detail')).toHaveCSS('background-color', 'rgb(243, 243, 243)');
  await expect(page.locator('.ksheet-back')).toHaveCSS('color', 'rgb(0, 86, 168)');
  await expect(page.locator('.ksub-page-task')).toHaveCSS('color', 'rgb(15, 23, 42)');
  await expect(page.locator('.kreport-card-text strong')).toHaveCSS('color', 'rgb(15, 23, 42)');
  await expect(page.locator('.kreport-header-text strong')).toHaveCSS('color', 'rgb(15, 23, 42)');
  await expect(page.locator('.kimage-toolbar')).toHaveCSS('background-color', 'rgb(89, 92, 93)');
  await expect(page.locator('.kimage-toolbar button:disabled')).toHaveCSS('opacity', '0.4');
});
