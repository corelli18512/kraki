import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { assertSafeProductionRelayUrl } from './src/lib/build-env';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, __dirname, '');
  assertSafeProductionRelayUrl(command, mode, env.VITE_WS_URL);

  const plugins: any[] = [react(), tailwindcss()];

  // When launched by `pnpm dev:local`, redirect bare page loads to the auth
  // server so every refresh gets a fresh pairing token automatically.
  const devAuthPort = process.env.KRAKI_DEV_AUTH_PORT;
  if (devAuthPort) {
    plugins.push({
      name: 'kraki-dev-auth-redirect',
      configureServer(server: any) {
        server.middlewares.use((req: any, res: any, next: any) => {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          if (req.method === 'GET' && url.pathname === '/' && !url.searchParams.has('token')) {
            res.writeHead(302, { Location: `http://localhost:${devAuthPort}` });
            res.end();
            return;
          }
          next();
        });
      },
    });
  }

  return {
    plugins,
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
