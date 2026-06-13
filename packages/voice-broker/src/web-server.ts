/**
 * Static file server for the mic capture test page (`web/index.html`).
 *
 * Used by `kraki-voice-broker web` so you don't need a separate dev server to
 * try the browser end of the pipeline. Defaults to http://127.0.0.1:7802.
 */

import { createReadStream, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, type Logger } from './logger.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wav': 'audio/wav',
};

export interface WebOptions {
  port?: number;
  host?: string;
  rootDir?: string;
  logger?: Logger;
}

export interface WebServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startWebServer(opts: WebOptions = {}): Promise<WebServer> {
  const port = opts.port ?? 7802;
  const host = opts.host ?? '127.0.0.1';
  const logger = opts.logger ?? createLogger('web');

  // Default root: packages/voice-broker/web (alongside dist/)
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultRoot = resolve(here, '..', 'web');
  const root = opts.rootDir ? resolve(opts.rootDir) : defaultRoot;

  if (!existsSync(root)) {
    throw new Error(`web root not found: ${root}`);
  }

  const http = createServer((req, res) => {
    const url = req.url ?? '/';
    let pathname = url.split('?')[0];
    if (pathname === '/') pathname = '/index.html';
    const safe = normalize(pathname).replace(/^([/\\])+/, '');
    const filePath = join(root, safe);
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
    createReadStream(filePath).pipe(res);
  });

  await new Promise<void>((resolve) => http.listen(port, host, () => resolve()));
  const url = `http://${host}:${port}/`;
  logger.info('serving static files', { url, root });

  return {
    port,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
