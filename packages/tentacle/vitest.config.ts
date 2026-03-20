import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    testTimeout: 10000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.integration.test.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@kraki/crypto': resolve(__dirname, '../crypto/src/index.ts'),
      '@kraki/protocol': resolve(__dirname, '../protocol/src/index.ts'),
    },
  },
});
