import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.live.test.ts'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@kraki/head': resolve(__dirname, '../head/src/index.ts'),
      '@kraki/tentacle': resolve(__dirname, '../tentacle/src/index.ts'),
      '@kraki/protocol': resolve(__dirname, '../protocol/src/index.ts'),
      '@kraki/crypto': resolve(__dirname, '../crypto/src/index.ts'),
      '@kraki/voice-broker/mock': resolve(__dirname, '../voice-broker/src/mock-doubao.ts'),
      '@kraki/voice-broker/logger': resolve(__dirname, '../voice-broker/src/logger.ts'),
      '@kraki/voice-broker': resolve(__dirname, '../voice-broker/src/index.ts'),
    },
  },
});
