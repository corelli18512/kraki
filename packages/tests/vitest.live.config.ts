import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@kraki/head': resolve(__dirname, '../head/src/index.ts'),
      '@kraki/tentacle': resolve(__dirname, '../tentacle/src/index.ts'),
      '@kraki/protocol': resolve(__dirname, '../protocol/src/index.ts'),
      '@kraki/crypto': resolve(__dirname, '../crypto/src/index.ts'),
    },
  },
});
