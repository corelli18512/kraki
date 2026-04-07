import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { generateKeyPairSync, createSign } from 'crypto';
import { HeadServer } from '../server.js';
import { Storage } from '../storage.js';
import { OpenAuthProvider, GitHubAuthProvider } from '../auth.js';
import type { HeadServerOptions } from '../server.js';

// --- Helpers ---

function mockFetch(status: number, body: Record<string, unknown>): typeof fetch {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Returns different GitHub users based on the Bearer token. */
function mockGitHubFetcher(users: Record<string, { id: number | string; login: string }>): typeof fetch {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const token = (headers?.Authorization ?? '').replace('Bearer ', '');
    const user = users[token];
    if (!user) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify(user), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForMessageOfType(ws: WebSocket, type: string, timeout = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for "${type}"`));
    }, timeout);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', () => resolve());
  });
}

interface TestHead {
  storage: Storage;
  server: HeadServer;
  httpServer: Server;
  port: number;
}

async function createHead(opts?: Partial<HeadServerOptions>): Promise<TestHead> {
  const storage = new Storage(':memory:');
  const options: HeadServerOptions = {
    authProvider: new OpenAuthProvider(),
    ...opts,
  };
  const server = new HeadServer(storage, options);
  const httpServer = createServer();
  server.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return { storage, server, httpServer, port };
}

function connect(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`);
}

async function authConnect(
  port: number,
  name: string,
  role: 'tentacle' | 'app',
  extra?: {
    token?: string;
    deviceId?: string;
    kind?: string;
    publicKey?: string;
    encryptionKey?: string;
    pairingToken?: string;
  },
): Promise<{ ws: WebSocket; authOk: Record<string, unknown> }> {
  const ws = connect(port);
  await waitForOpen(ws);
  const authMsg: Record<string, unknown> = {
    type: 'auth',
    auth: extra?.pairingToken
      ? { method: 'pairing', token: extra.pairingToken }
      : extra?.token
        ? { method: 'github_token', token: extra.token }
        : { method: 'open' },
    device: {
      name,
      role,
      kind: extra?.kind,
      deviceId: extra?.deviceId,
      publicKey: extra?.publicKey,
      encryptionKey: extra?.encryptionKey,
    },
  };
  ws.send(JSON.stringify(authMsg));
  const authOk = await waitForMessage(ws);
  return { ws, authOk };
}

// --- Tests ---

describe('HeadServer (thin relay)', () => {
  let head: TestHead;

  afterEach(async () => {
    head?.server.close();
    await new Promise<void>((resolve) => head?.httpServer.close(() => resolve()));
    head?.storage.close();
  });

  // ── Auth ──────────────────────────────────────────────

  describe('auth', () => {
    it('should auth in open mode → auth_ok with deviceId, user, devices', async () => {
      head = await createHead();
      const { authOk } = await authConnect(head.port, 'Laptop', 'tentacle');
      expect(authOk.type).toBe('auth_ok');
      expect(authOk.deviceId).toMatch(/^dev_/);
      expect(authOk.user).toEqual({ id: 'local', login: 'local', provider: 'open' });
      expect(authOk.devices).toHaveLength(1);
      expect(authOk.devices[0].name).toBe('Laptop');
    });

    it('should auth with GitHub token → auth_ok', async () => {
      const fetcher = mockFetch(200, { id: 12345, login: 'corelli' });
      head = await createHead({ authProvider: new GitHubAuthProvider({ fetcher }) });
      const { authOk } = await authConnect(head.port, 'Laptop', 'tentacle', { token: 'valid_token' });
      expect(authOk.type).toBe('auth_ok');
      expect(authOk.user.login).toBe('corelli');
    });

    it('should reject invalid GitHub token → auth_error', async () => {
      const fetcher = mockFetch(401, { message: 'Bad credentials' });
      head = await createHead({ authProvider: new GitHubAuthProvider({ fetcher }) });
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'github_token', token: 'bad_token' },
        device: { name: 'Laptop', role: 'tentacle' },
      }));
      const res = await waitForMessage(ws);
      expect(res.type).toBe('auth_error');
      expect(res.code).toBe('auth_rejected');
      ws.close();
    });

    it('should reject missing token for GitHub auth → auth_error', async () => {
      head = await createHead({ authProvider: new GitHubAuthProvider() });
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'github_token' },
        device: { name: 'Laptop', role: 'tentacle' },
      }));
      const res = await waitForMessage(ws);
      expect(res.type).toBe('auth_error');
      expect(res.code).toBe('auth_rejected');
      expect(res.message).toContain('Token required');
      ws.close();
    });

    it('should reject messages before auth', async () => {
      head = await createHead();
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'broadcast', blob: 'x', keys: {} }));
      const res = await waitForMessage(ws);
      expect(res.type).toBe('server_error');
      expect(res.message).toContain('authenticate');
      ws.close();
    });

    it('should reject invalid auth (missing device info)', async () => {
      head = await createHead();
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth' }));
      const res = await waitForMessage(ws);
      expect(res.type).toBe('server_error');
      expect(res.message).toContain('device');
      ws.close();
    });

    it('should return growing device list in auth_ok', async () => {
      head = await createHead();
      const { authOk: a1 } = await authConnect(head.port, 'Laptop', 'tentacle');
      expect(a1.devices).toHaveLength(1);
      const { authOk: a2 } = await authConnect(head.port, 'Phone', 'app');
      expect(a2.devices).toHaveLength(2);
    });
  });

  // ── auth_info ─────────────────────────────────────────

  describe('auth_info', () => {
    it('should return auth modes, pairing flag', async () => {
      head = await createHead();
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth_info' }));
      const res = await waitForMessage(ws);
      expect(res.type).toBe('auth_info_response');
      expect(res.methods).toBeTruthy();
      expect(res.methods).toContain('pairing');
      ws.close();
    });

    it('should include githubClientId when configured', async () => {
      head = await createHead({
        authProvider: new GitHubAuthProvider({ clientId: 'cid', clientSecret: 'sec' }),
      });
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth_info' }));
      const res = await waitForMessage(ws);
      expect(res.githubClientId).toBe('cid');
      ws.close();
    });
  });

  // ── Broadcast forwarding ──────────────────────────────

  describe('broadcast forwarding', () => {
    it('should forward broadcast to other connected devices of same user', async () => {
      head = await createHead();
      const { ws: tentacle } = await authConnect(head.port, 'Laptop', 'tentacle');
      const { ws: app } = await authConnect(head.port, 'Phone', 'app');

      const msgP = waitForMessageOfType(app, 'broadcast');
      tentacle.send(JSON.stringify({
        type: 'broadcast',
        blob: 'encrypted_data',
        keys: { phone: 'key1' },
      }));
      const received = await msgP;
      expect(received.blob).toBe('encrypted_data');
      expect(received.keys).toEqual({ phone: 'key1' });
    });

    it('should deliver broadcast to multiple apps', async () => {
      head = await createHead();
      const { ws: tentacle } = await authConnect(head.port, 'Laptop', 'tentacle');
      const { ws: app1 } = await authConnect(head.port, 'Phone', 'app');
      const { ws: app2 } = await authConnect(head.port, 'Browser', 'app');

      const p1 = waitForMessageOfType(app1, 'broadcast');
      const p2 = waitForMessageOfType(app2, 'broadcast');
      tentacle.send(JSON.stringify({ type: 'broadcast', blob: 'data', keys: {} }));

      const [m1, m2] = await Promise.all([p1, p2]);
      expect(m1.blob).toBe('data');
      expect(m2.blob).toBe('data');
    });
  });

  // ── Unicast forwarding ────────────────────────────────

  describe('unicast forwarding', () => {
    it('should forward unicast to the target device', async () => {
      head = await createHead();
      const { ws: tentacle, authOk: tAuth } = await authConnect(head.port, 'Laptop', 'tentacle');
      const { ws: app } = await authConnect(head.port, 'Phone', 'app');

      const msgP = waitForMessageOfType(tentacle, 'unicast');
      app.send(JSON.stringify({
        type: 'unicast',
        to: tAuth.deviceId,
        blob: 'for_tentacle',
        keys: { [tAuth.deviceId]: 'k' },
      }));
      const received = await msgP;
      expect(received.to).toBe(tAuth.deviceId);
      expect(received.blob).toBe('for_tentacle');
    });

    it('should silently drop unicast to nonexistent device', async () => {
      head = await createHead();
      const { ws: app } = await authConnect(head.port, 'Phone', 'app');
      // Should not crash
      app.send(JSON.stringify({
        type: 'unicast', to: 'dev_nope', blob: 'x', keys: {},
      }));
      await new Promise((r) => setTimeout(r, 100));
    });

    it('should silently drop unicast to device of another user', async () => {
      const fetcher = mockGitHubFetcher({
        tok_alice: { id: 'alice', login: 'alice' },
        tok_bob: { id: 'bob', login: 'bob' },
      });
      head = await createHead({ authProvider: new GitHubAuthProvider({ fetcher }) });

      const { ws: aliceWs } = await authConnect(head.port, 'A-Laptop', 'tentacle', { token: 'tok_alice' });
      const { ws: bobWs, authOk: bobAuth } = await authConnect(head.port, 'B-Phone', 'app', { token: 'tok_bob' });

      // Alice tries unicast to Bob's device → dropped
      let bobGot = false;
      bobWs.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'unicast') bobGot = true;
      });

      aliceWs.send(JSON.stringify({
        type: 'unicast', to: bobAuth.deviceId, blob: 'x', keys: {},
      }));
      await new Promise((r) => setTimeout(r, 200));
      expect(bobGot).toBe(false);
    });
  });

  // ── Broadcast isolation ───────────────────────────────

  describe('broadcast isolation', () => {
    it('should NOT deliver broadcast to devices of another user', async () => {
      const fetcher = mockGitHubFetcher({
        tok_alice: { id: 'alice', login: 'alice' },
        tok_bob: { id: 'bob', login: 'bob' },
      });
      head = await createHead({ authProvider: new GitHubAuthProvider({ fetcher }) });

      const { ws: aliceTentacle } = await authConnect(head.port, 'A-Laptop', 'tentacle', { token: 'tok_alice' });
      const { ws: bobApp } = await authConnect(head.port, 'B-Phone', 'app', { token: 'tok_bob' });

      let bobGotBroadcast = false;
      bobApp.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'broadcast') bobGotBroadcast = true;
      });

      aliceTentacle.send(JSON.stringify({
        type: 'broadcast', blob: 'alice_secret', keys: {},
      }));
      await new Promise((r) => setTimeout(r, 200));
      expect(bobGotBroadcast).toBe(false);
    });
  });

  // ── Pairing flow ──────────────────────────────────────

  describe('pairing flow', () => {
    it('tentacle creates token → app pairs → auth_ok', async () => {
      head = await createHead();
      const { ws: tentacle } = await authConnect(head.port, 'Laptop', 'tentacle');

      const tokP = waitForMessageOfType(tentacle, 'pairing_token_created');
      tentacle.send(JSON.stringify({ type: 'create_pairing_token' }));
      const tokMsg = await tokP;
      expect(tokMsg.token).toMatch(/^pt_/);
      expect(tokMsg.expiresIn).toBeGreaterThan(0);

      const { authOk } = await authConnect(head.port, 'Phone', 'app', {
        pairingToken: tokMsg.token,
      });
      expect(authOk.type).toBe('auth_ok');
      expect(authOk.devices.length).toBeGreaterThanOrEqual(2);
    });

    it('should reject invalid pairing token', async () => {
      head = await createHead();
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'pairing', token: 'pt_bogus' },
        device: { name: 'Phone', role: 'app' },
      }));
      const res = await waitForMessage(ws);
      expect(res.type).toBe('auth_error');
      expect(res.code).toBe('invalid_pairing_token');
      expect(res.message).toContain('Invalid or expired');
      ws.close();
    });

    it('pairing token is single-use', async () => {
      head = await createHead();
      const { ws: tentacle } = await authConnect(head.port, 'Laptop', 'tentacle');

      const tokP = waitForMessageOfType(tentacle, 'pairing_token_created');
      tentacle.send(JSON.stringify({ type: 'create_pairing_token' }));
      const { token } = await tokP;

      // First use succeeds
      const { authOk } = await authConnect(head.port, 'Phone', 'app', { pairingToken: token });
      expect(authOk.type).toBe('auth_ok');

      // Second use fails
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'pairing', token: token },
        device: { name: 'Browser', role: 'app' },
      }));
      const res = await waitForMessage(ws);
      expect(res.type).toBe('auth_error');
      expect(res.code).toBe('invalid_pairing_token');
      ws.close();
    });
  });

  // ── Challenge-response ────────────────────────────────

  describe('challenge-response auth', () => {
    function generateKeys() {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const compact = (publicKey as string)
        .replace('-----BEGIN PUBLIC KEY-----', '')
        .replace('-----END PUBLIC KEY-----', '')
        .replace(/\n/g, '');
      return { compact, privateKey: privateKey as string };
    }

    it('should authenticate returning device via challenge-response', async () => {
      head = await createHead();
      const { compact, privateKey } = generateKeys();

      // Register device with public key
      const { ws: ws1, authOk: first } = await authConnect(head.port, 'Laptop', 'tentacle', {
        publicKey: compact,
      });
      const deviceId = first.deviceId;
      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Reconnect with deviceId only → challenge
      const ws2 = connect(head.port);
      await waitForOpen(ws2);
      ws2.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'challenge', deviceId },
        device: { name: 'Laptop', role: 'tentacle', deviceId },
      }));

      const challenge = await waitForMessage(ws2);
      expect(challenge.type).toBe('auth_challenge');
      expect(challenge.nonce).toBeTruthy();

      // Sign nonce
      const sign = createSign('SHA256');
      sign.update(challenge.nonce);
      const signature = sign.sign(privateKey, 'base64');

      ws2.send(JSON.stringify({ type: 'auth_response', deviceId, signature }));
      const authOk = await waitForMessage(ws2);
      expect(authOk.type).toBe('auth_ok');
      expect(authOk.deviceId).toBe(deviceId);
      ws2.close();
    });

    it('should reject unknown device for challenge auth', async () => {
      head = await createHead();

      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'challenge', deviceId: 'dev_missing' },
        device: { name: 'Laptop', role: 'tentacle', deviceId: 'dev_missing' },
      }));

      const res = await waitForMessage(ws);
      expect(res.type).toBe('auth_error');
      expect(res.code).toBe('unknown_device');
      expect(res.message).toContain('Unknown device');
      ws.close();
    });

    it('should reject invalid signature', async () => {
      head = await createHead();
      const { compact } = generateKeys();

      const { ws: ws1, authOk: first } = await authConnect(head.port, 'Laptop', 'tentacle', {
        publicKey: compact,
      });
      const deviceId = first.deviceId;
      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      const ws2 = connect(head.port);
      await waitForOpen(ws2);
      ws2.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'challenge', deviceId },
        device: { name: 'Laptop', role: 'tentacle', deviceId },
      }));
      const challenge = await waitForMessage(ws2);
      expect(challenge.type).toBe('auth_challenge');

      ws2.send(JSON.stringify({
        type: 'auth_response', deviceId, signature: 'bad_sig',
      }));
      const res = await waitForMessage(ws2);
      expect(res.type).toBe('auth_error');
      expect(res.code).toBe('invalid_signature');
      expect(res.message).toContain('Invalid signature');
      ws2.close();
    });
  });

  // ── Disconnect cleanup ────────────────────────────────

  describe('disconnect cleanup', () => {
    it('should stop delivering to disconnected device', async () => {
      head = await createHead();
      const { ws: tentacle } = await authConnect(head.port, 'Laptop', 'tentacle');
      const { ws: app1 } = await authConnect(head.port, 'Phone', 'app');

      // Broadcast reaches app1
      const p1 = waitForMessageOfType(app1, 'broadcast');
      tentacle.send(JSON.stringify({ type: 'broadcast', blob: 'before', keys: {} }));
      await p1;

      // Disconnect app1
      app1.close();
      await new Promise((r) => setTimeout(r, 100));

      // New app connects
      const { ws: app2 } = await authConnect(head.port, 'Browser', 'app');
      const p2 = waitForMessageOfType(app2, 'broadcast');
      tentacle.send(JSON.stringify({ type: 'broadcast', blob: 'after', keys: {} }));
      const m = await p2;
      expect(m.blob).toBe('after');
    });
  });

  // ── Edge cases ────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle invalid JSON gracefully', async () => {
      head = await createHead();
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send('this is not json {{{');
      const res = await waitForMessage(ws);
      expect(res.type).toBe('server_error');
      expect(res.message).toContain('Invalid JSON');
      ws.close();
    });

    it('should handle invalid message format (not an object)', async () => {
      head = await createHead();
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.send(JSON.stringify(42));
      const res = await waitForMessage(ws);
      expect(res.type).toBe('server_error');
      ws.close();
    });

    it('should reject unknown message type after auth', async () => {
      head = await createHead();
      const { ws } = await authConnect(head.port, 'Laptop', 'tentacle');
      ws.send(JSON.stringify({ type: 'totally_unknown' }));
      const res = await waitForMessageOfType(ws, 'server_error');
      expect(res.message).toContain('Unknown message type');
    });

    it('should handle unauthenticated close without error', async () => {
      head = await createHead();
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('should handle WebSocket error by closing', async () => {
      head = await createHead();
      const ws = connect(head.port);
      await waitForOpen(ws);
      ws.on('error', () => {});
      ws.emit('error', new Error('test'));
      await new Promise((r) => setTimeout(r, 50));
    });

    it('should accept connections via acceptConnection', async () => {
      head = await createHead();
      const directWss = new WebSocketServer({ port: 0 });
      const directPort = (directWss.address() as AddressInfo).port;
      const directStorage = new Storage(':memory:');
      const directServer = new HeadServer(directStorage, { authProvider: new OpenAuthProvider() });

      directWss.on('connection', (ws) => directServer.acceptConnection(ws));

      const ws = new WebSocket(`ws://127.0.0.1:${directPort}`);
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'open' },
        device: { name: 'Direct', role: 'tentacle' },
      }));
      const authOk = await waitForMessage(ws);
      expect(authOk.type).toBe('auth_ok');

      ws.close();
      directServer.close();
      directWss.close();
      directStorage.close();
    });

    it('should reject invalid broadcast (missing blob)', async () => {
      head = await createHead();
      const { ws } = await authConnect(head.port, 'Laptop', 'tentacle');
      ws.send(JSON.stringify({ type: 'broadcast', keys: {} }));
      const res = await waitForMessageOfType(ws, 'server_error');
      expect(res.message).toContain('blob');
    });

    it('should reject invalid unicast (missing to)', async () => {
      head = await createHead();
      const { ws } = await authConnect(head.port, 'Laptop', 'tentacle');
      ws.send(JSON.stringify({ type: 'unicast', blob: 'x', keys: {} }));
      const res = await waitForMessageOfType(ws, 'server_error');
      expect(res.message).toContain('to');
    });

    it('should queue unicast for offline device and deliver on reconnect', async () => {
      head = await createHead();

      // Connect tentacle, note its deviceId, then disconnect
      const { ws: tentacleWs, authOk: tentacleAuth } = await authConnect(head.port, 'Tentacle', 'tentacle', { deviceId: 'dev-t1' });
      const tentacleDeviceId = tentacleAuth.deviceId as string;
      tentacleWs.close();
      await new Promise((r) => setTimeout(r, 100));

      // Connect an app and send a unicast to the offline tentacle
      const { ws: appWs } = await authConnect(head.port, 'Phone', 'app');
      appWs.send(JSON.stringify({
        type: 'unicast',
        to: tentacleDeviceId,
        blob: 'encrypted-delete-blob',
        keys: { [tentacleDeviceId]: 'wrapped-key' },
      }));
      // No server_error should come back — give it a moment
      await new Promise((r) => setTimeout(r, 200));

      // Reconnect tentacle — auth_ok should contain pendingMessages
      const tentacle2 = connect(head.port);
      await waitForOpen(tentacle2);
      tentacle2.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'open' },
        device: { name: 'Tentacle', role: 'tentacle', deviceId: tentacleDeviceId },
      }));
      const authOk2 = await waitForMessage(tentacle2);
      expect(authOk2.type).toBe('auth_ok');
      expect(authOk2.pendingMessages).toHaveLength(1);
      const pending = (authOk2.pendingMessages as Record<string, unknown>[])[0];
      expect(pending.blob).toBe('encrypted-delete-blob');
      expect((pending.keys as Record<string, string>)[tentacleDeviceId]).toBe('wrapped-key');

      // Second reconnect should have no pending messages
      tentacle2.close();
      await new Promise((r) => setTimeout(r, 100));
      const tentacle3 = connect(head.port);
      await waitForOpen(tentacle3);
      tentacle3.send(JSON.stringify({
        type: 'auth',
        auth: { method: 'open' },
        device: { name: 'Tentacle', role: 'tentacle', deviceId: tentacleDeviceId },
      }));
      const authOk3 = await waitForMessage(tentacle3);
      expect(authOk3.pendingMessages).toBeUndefined();

      appWs.close();
      tentacle3.close();
    });
  });

  describe('preferences', () => {
    it('broadcasts preferences_updated to other devices of the same user', async () => {
      head = await createHead();

      // Connect two devices for the same user (open auth → same user)
      const { ws: ws1 } = await authConnect(head.port, 'App1', 'app', { deviceId: 'app-1' });
      const { ws: ws2 } = await authConnect(head.port, 'App2', 'app', { deviceId: 'app-2' });
      // Drain device_joined that ws1 receives when ws2 connects
      await waitForMessageOfType(ws1, 'device_joined');

      // ws1 sends update_preferences
      const prefPromise = waitForMessageOfType(ws2, 'preferences_updated');
      ws1.send(JSON.stringify({ type: 'update_preferences', preferences: { debugLogging: true, theme: 'dark' } }));

      // ws1 should get confirmation
      const confirmation = await waitForMessageOfType(ws1, 'preferences_updated');
      expect(confirmation.preferences).toEqual(expect.objectContaining({ debugLogging: true, theme: 'dark' }));

      // ws2 should also get the broadcast
      const broadcast = await prefPromise;
      expect(broadcast.preferences).toEqual(expect.objectContaining({ debugLogging: true, theme: 'dark' }));

      ws1.close();
      ws2.close();
    });

    it('returns merged preferences in auth_ok', async () => {
      head = await createHead();

      // Connect and set preferences
      const { ws: ws1, authOk: authOk1 } = await authConnect(head.port, 'App1', 'app', { deviceId: 'app-a' });
      // Initial preferences should be undefined
      const user1 = authOk1.user as Record<string, unknown>;
      expect(user1.preferences).toBeUndefined();

      // Set a preference
      ws1.send(JSON.stringify({ type: 'update_preferences', preferences: { debugLogging: true } }));
      await waitForMessageOfType(ws1, 'preferences_updated');
      ws1.close();

      // Reconnect — preferences should be in auth_ok
      const { ws: ws2, authOk: authOk2 } = await authConnect(head.port, 'App2', 'app', { deviceId: 'app-b' });
      const user2 = authOk2.user as Record<string, unknown>;
      expect(user2.preferences).toEqual(expect.objectContaining({ debugLogging: true }));
      ws2.close();
    });
  });
});
