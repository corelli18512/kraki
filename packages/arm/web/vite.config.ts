import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { assertSafeProductionRelayUrl } from './src/lib/build-env';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, __dirname, '');
  assertSafeProductionRelayUrl(command, mode, env.VITE_WS_URL);

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 3000,
    },
    resolve: {
      alias: {
        '@kraki/protocol': resolve(__dirname, '../../../packages/protocol/src/index.ts'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router'],
            markdown: ['react-markdown', 'rehype-highlight'],
          },
        },
      },
    },
  };
});
