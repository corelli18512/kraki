import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  test: {
    include: ['src/__tests__/pi087-live.integration.test.ts'],
    exclude: [],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
  resolve: { alias: {
    '@kraki/crypto': resolve(__dirname, '../crypto/src/index.ts'),
    '@kraki/protocol': resolve(__dirname, '../protocol/src/index.ts'),
  } },
});
