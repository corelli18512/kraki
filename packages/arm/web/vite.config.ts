import { defineConfig, loadEnv, type PluginOption, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { IncomingMessage, ServerResponse } from 'http';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { assertSafeProductionRelayUrl } from './src/lib/build-env';

function getGitHash(): string {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, __dirname, '');
  assertSafeProductionRelayUrl(command, mode, env.VITE_WS_URL);

  const plugins: PluginOption[] = [react(), tailwindcss()];

  // When launched by `pnpm dev:local`, redirect bare page loads to the auth
  // server so every refresh gets a fresh pairing token automatically.
  const devAuthPort = process.env.KRAKI_DEV_AUTH_PORT;
  if (devAuthPort) {
    plugins.push({
      name: 'kraki-dev-auth-redirect',
      configureServer(server: ViteDevServer) {
        server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
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
    define: {
      __GIT_HASH__: JSON.stringify(getGitHash()),
    },
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
