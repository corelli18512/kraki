/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Never the developer's real HOME / ~/.kraki.
    setupFiles: [resolve(__dirname, '../../../scripts/vitest/isolated-home.setup.ts'), 'src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/boot.tsx', 'src/mock/**', 'src/types/**', 'src/test/**'],
    },
  },
});
