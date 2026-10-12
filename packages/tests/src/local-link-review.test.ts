import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LocalLinkServer, type LocalLinkHost } from '../../tentacle/src/local-link.js';

function host(tentacleId: string): LocalLinkHost {
  return {
    tentacleId: () => tentacleId,
    privateKeyPem: () => undefined,
    appSigningKey: () => undefined,
    onPeerUp: () => {},
    onPeerDown: () => {},
    onDelivered: () => {},
  };
}

describe('local-link discovery ownership (independent review)', () => {
  it('an outgoing Tentacle must not delete the incoming Tentacle’s discovery record', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kraki-llr-discovery-'));
    const oldServer = new LocalLinkServer(host('old'), home);
    const newServer = new LocalLinkServer(host('new'), home);
    try {
      await oldServer.start();
      await newServer.start();
      expect(JSON.parse(readFileSync(newServer.filePath, 'utf8')).tentacleId).toBe('new');
      // During handover, the old daemon's shutdown can run after the new
      // daemon has published its listener. Discovery must continue to work.
      oldServer.stop();
      expect(existsSync(newServer.filePath)).toBe(true);
      expect(JSON.parse(readFileSync(newServer.filePath, 'utf8')).port).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(newServer.filePath, 'utf8')).tentacleId).toBe('new');
    } finally {
      oldServer.stop();
      newServer.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('shutdown closes unauthenticated local sockets immediately, not after the handshake timeout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kraki-llr-unauth-'));
    const server = new LocalLinkServer(host('T'), home);
    let socket: WebSocket | undefined;
    try {
      await server.start();
      const { port } = JSON.parse(readFileSync(server.filePath, 'utf8'));
      socket = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        socket!.once('open', resolve);
        socket!.once('error', reject);
      });
      server.stop();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      socket?.terminate();
      server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
