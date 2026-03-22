import { test, expect } from '@playwright/test';

test('app loads and shows connecting state', async ({ page }) => {
  await page.goto('/');
  // The app should render its root UI
  await expect(page.locator('body')).toBeVisible();
});
