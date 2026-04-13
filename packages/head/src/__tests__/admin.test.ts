import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo, IncomingMessage, ServerResponse } from 'net';
import { HeadServer } from '../server.js';
import { Storage } from '../storage.js';
import { OpenAuthProvider, safeEqual } from '../auth.js';

function createAdminHandler(head: HeadServer, adminKey: string, version = '0.0.1') {
  const startedAt = Date.now();
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/admin/stats') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!adminKey) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      const authHeader = req.headers.authorization ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!token || !safeEqual(token, adminKey)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const stats = head.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version, uptime: Math.floor((Date.now() - startedAt) / 1000), ...stats }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: '@kraki/head', version, status: 'ok' }));
  };
}

async function createTestServer(adminKey: string) {
  const storage = new Storage(':memory:');
  const server = new HeadServer(storage, { authProvider: new OpenAuthProvider() });
  const httpServer = createServer(createAdminHandler(server, adminKey));
  server.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return { storage, server, httpServer, port };
}

describe('Admin stats HTTP endpoint', () => {
  let httpServer: Server;
  let server: HeadServer;
  let storage: Storage;
  let port: number;

  afterEach(async () => {
    server?.close();
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    storage?.close();
  });

  it('should return 404 when ADMIN_KEY is not set', async () => {
    ({ storage, server, httpServer, port } = await createTestServer(''));
    const res = await fetch(`http://127.0.0.1:${port}/admin/stats`);
    expect(res.status).toBe(404);
  });

  it('should return 401 with missing auth header', async () => {
    ({ storage, server, httpServer, port } = await createTestServer('secret123'));
    const res = await fetch(`http://127.0.0.1:${port}/admin/stats`);
    expect(res.status).toBe(401);
  });

  it('should return 401 with wrong key', async () => {
    ({ storage, server, httpServer, port } = await createTestServer('secret123'));
    const res = await fetch(`http://127.0.0.1:${port}/admin/stats`, {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    expect(res.status).toBe(401);
  });

  it('should return 200 with correct key and valid stats shape', async () => {
    ({ storage, server, httpServer, port } = await createTestServer('secret123'));
    const res = await fetch(`http://127.0.0.1:${port}/admin/stats`, {
      headers: { Authorization: 'Bearer secret123' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.version).toBe('0.0.1');
    expect(typeof body.uptime).toBe('number');
    expect(body.users).toEqual({ total: 0, online: 0 });
    expect(body.devices).toEqual({ total: 0, online: 0 });
    expect(body.connections).toEqual([]);
  });

  it('should handle CORS preflight', async () => {
    ({ storage, server, httpServer, port } = await createTestServer('secret123'));
    const res = await fetch(`http://127.0.0.1:${port}/admin/stats`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toBe('Authorization');
  });

  it('should still serve health on /', async () => {
    ({ storage, server, httpServer, port } = await createTestServer('secret123'));
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
