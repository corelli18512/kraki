import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // real-stack/ owns a separate config (playwright.realstack.config.ts) and needs
  // the orchestrator's control plane on :4710. Keep it out of the default run,
  // which uses per-test random-port mock relays.
  testIgnore: '**/real-stack/**',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
