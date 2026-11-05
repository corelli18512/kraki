import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { relayConnectErrorMessage } from '../network-errors.js';
import { queryRelayInfo } from '../setup.js';

describe('relay connection errors (K-278)', () => {
  it('explains a reverse proxy that answers plain HTTP to the WebSocket upgrade', async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const failure = await queryRelayInfo(`ws://127.0.0.1:${port}`).catch((err: Error) => err);
      expect((failure as Error).message).toContain('answered HTTP 200 instead of opening a WebSocket');
      expect((failure as Error).message).toContain('reverse proxy');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps other connection errors as they are', () => {
    expect(relayConnectErrorMessage(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe('connect ECONNREFUSED 127.0.0.1:1');
    expect(relayConnectErrorMessage(undefined)).toBe('Connection failed');
  });
});
