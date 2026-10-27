import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  test: {
    include: ['src/__tests__/pi087-live.integration.test.ts'],
    exclude: [],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    // The live pi needs the user's credentials under HOME; only the Kraki
    // home is isolated.
    env: { KRAKI_TEST_REAL_HOME: '1' },
    setupFiles: [resolve(__dirname, '../../scripts/vitest/isolated-home.setup.ts')],
  },
  resolve: { alias: {
    '@kraki/crypto': resolve(__dirname, '../crypto/src/index.ts'),
    '@kraki/protocol/schemas': resolve(__dirname, '../protocol/src/schemas.ts'),
    '@kraki/protocol': resolve(__dirname, '../protocol/src/index.ts'),
  } },
});
