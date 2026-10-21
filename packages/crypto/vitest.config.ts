import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Never the developer's real HOME / ~/.kraki.
    setupFiles: [resolve(__dirname, '../../scripts/vitest/isolated-home.setup.ts')],
    testTimeout: 30_000,
    teardownTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
