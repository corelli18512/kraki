import { defineConfig } from '@playwright/test';

/**
 * Web network-resilience scenarios against the isolated chaos stack
 * (packages/tests/src/chaos). Started by scripts/chaos/run-web.sh, which writes
 * /tmp/kraki-chaos/stack.json; the specs drive faults via its control plane.
 */
export default defineConfig({
  testDir: './e2e/resilience',
  timeout: 240_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: '/tmp/kraki-chaos/web-report.json' }]],
  use: {
    baseURL: 'http://localhost:4180',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4180 --strictPort',
    port: 4180,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
