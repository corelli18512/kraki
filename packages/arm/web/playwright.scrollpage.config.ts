import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({ ...base, use: { ...base.use, baseURL: 'http://localhost:4187' }, webServer: {
  command: 'pnpm preview --port 4187', port: 4187, reuseExistingServer: false, timeout: 60000,
} });
