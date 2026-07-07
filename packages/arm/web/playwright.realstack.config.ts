import { defineConfig } from '@playwright/test';

/**
 * Real-stack pulse verification — a SEPARATE Playwright project from the default
 * mock-relay e2e (playwright.config.ts on :4173). Here the webServer is the real
 * orchestrator (real head + real tentacle + built arm) started from repo root;
 * the spec drives the tentacle via the HTTP control plane on :4710 and asserts
 * the real browser arm's UI.
 *
 * Run from repo root:  pnpm exec playwright test -c packages/arm/web/playwright.realstack.config.ts
 * (or the `verify:pulse-realstack` script).
 */
export default defineConfig({
  testDir: './e2e/real-stack',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:3700',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Orchestrator lives at repo root and needs workspace packages, so run from there.
    command: 'pnpm exec tsx scripts/pulse-realstack-server.ts',
    cwd: '../../..',
    // The control plane is the last thing to come up → readiness signal.
    url: 'http://localhost:4710/killed',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [{ name: 'realstack-chromium', use: { browserName: 'chromium' } }],
});
