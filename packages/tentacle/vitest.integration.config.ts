import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 120000,
    // Real agent CLIs need the user's credentials under HOME; only the Kraki
    // home is isolated.
    env: { KRAKI_TEST_REAL_HOME: '1' },
    setupFiles: [resolve(__dirname, '../../scripts/vitest/isolated-home.setup.ts')],
  },
});
