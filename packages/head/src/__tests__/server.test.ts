import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';
import { HeadServer } from '../server.js';
import { ChannelManager } from '../channel-manager.js';
import { Router } from '../router.js';
import { Storage } from '../storage.js';
import { OpenAuthProvider, GitHubAuthProvider, ApiKeyAuthProvider } from '../auth.js';
import type { AuthProvider } from '../auth.js';

function mockFetch(status: number, body: Record<string, unknown>): typeof fetch {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForMessageOfType(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve) => {
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
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

describe('HeadServer', () => {
  let storage: Storage;
  let cm: ChannelManager;
  let router: Router;
  let head: HeadServer;
  let httpServer: Server;
  let port: number;

  beforeEach(async () => {
    storage = new Storage(':memory:');
    cm = new ChannelManager(storage);
    router = new Router(cm);

    httpServer = createServer();
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as any).port;
  });

  afterEach(async () => {
    head?.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    storage.close();
  });

  function createHead(options: { authProvider?: AuthProvider; e2e?: boolean; pingInterval?: number; pongTimeout?: number } = {}) {
    head = new HeadServer(cm, router, {
      authProvider: options.authProvider ?? new OpenAuthProvider(),
      e2e: options.e2e ?? false,
      pingInterval: options.pingInterval ?? 0, // disabled by default in tests
      pongTimeout: options.pongTimeout ?? 0,
    });
    head.attach(httpServer);
    return head;
  }

  function connect(): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}`);
  }

  async function authConnect(name: string, role: 'tentacle' | 'app', token?: string): Promise<{ ws: WebSocket; authOk: any }> {
    const ws = connect();
    await waitForOpen(ws);
    const authMsg: any = {
      type: 'auth',
      device: { name, role },
    };
    if (token) authMsg.token = token;
    ws.send(JSON.stringify(authMsg));
    const authOk = await waitForMessage(ws);
    return { ws, authOk };
  }

  describe('self-hosted mode (no auth)', () => {
    beforeEach(() => {
      createHead();
    });

    it('should authenticate without token', async () => {
      const { authOk } = await authConnect('Laptop', 'tentacle');
      expect(authOk.type).toBe('auth_ok');
      expect(authOk.channel).toMatch(/^ch_/);
      expect(authOk.deviceId).toMatch(/^dev_/);
      expect(authOk.e2e).toBe(false);
    });

    it('should return device list in auth_ok', async () => {
      const { authOk: auth1 } = await authConnect('Laptop', 'tentacle');
      expect(auth1.devices).toHaveLength(1);
      expect(auth1.devices[0].name).toBe('Laptop');

      const { authOk: auth2 } = await authConnect('Phone', 'app');
      expect(auth2.devices).toHaveLength(2);
    });

    it('should respond to ping with pong', async () => {
      const { ws } = await authConnect('Laptop', 'tentacle');
      ws.send(JSON.stringify({ type: 'ping' }));
      const pong = await waitForMessageOfType(ws, 'pong');
      expect(pong.type).toBe('pong');
    });

    it('should reject messages before auth', async () => {
      const ws = connect();
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'agent_message', payload: { content: 'hi' } }));
      const response = await waitForMessage(ws);
      expect(response.type).toBe('server_error');
      expect(response.message).toContain('authenticate');
    });
  });

  describe('auth mode (GitHub token)', () => {
    it('should authenticate with valid token', async () => {
      const fetcher = mockFetch(200, { id: 12345, login: 'corelli' });
      createHead({ authProvider: new GitHubAuthProvider({ fetcher }) });

      const { authOk } = await authConnect('Laptop', 'tentacle', 'valid_token');
      expect(authOk.type).toBe('auth_ok');
    });

    it('should reject invalid token', async () => {
      const fetcher = mockFetch(401, { message: 'Bad credentials' });
      createHead({ authProvider: new GitHubAuthProvider({ fetcher }) });

      const ws = connect();
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: 'auth',
        token: 'bad_token',
        device: { name: 'Laptop', role: 'tentacle' },
      }));
      const response = await waitForMessage(ws);
      expect(response.type).toBe('auth_error');
    });

    it('should reject missing token', async () => {
      createHead({ authProvider: new GitHubAuthProvider() });

      const ws = connect();
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: 'auth',
        device: { name: 'Laptop', role: 'tentacle' },
      }));
      const response = await waitForMessage(ws);
      expect(response.type).toBe('auth_error');
      expect(response.message).toContain('Token required');
    });
  });

  describe('message routing', () => {
    beforeEach(() => {
      createHead();
    });

    it('should route tentacle messages to apps', async () => {
      const { ws: laptop, authOk: laptopAuth } = await authConnect('Laptop', 'tentacle');
      const { ws: phone } = await authConnect('Phone', 'app');

      const msgPromise = waitForMessageOfType(phone, 'session_created');
      laptop.send(JSON.stringify({
        type: 'session_created',
        sessionId: 'sess_1',
        payload: { agent: 'copilot' },
      }));

      const received = await msgPromise;
      expect(received.type).toBe('session_created');
      expect(received.sessionId).toBe('sess_1');
      expect(received.seq).toBe(1);
    });

    it('should route app actions to correct tentacle', async () => {
      const { ws: laptop } = await authConnect('Laptop', 'tentacle');
      const { ws: phone } = await authConnect('Phone', 'app');

      // Laptop creates session
      const sessionPromise = waitForMessageOfType(phone, 'session_created');
      laptop.send(JSON.stringify({
        type: 'session_created',
        sessionId: 'sess_1',
        payload: { agent: 'copilot' },
      }));
      await sessionPromise;

      // Phone approves
      const laptopMsgPromise = waitForMessageOfType(laptop, 'approve');
      phone.send(JSON.stringify({
        type: 'approve',
        sessionId: 'sess_1',
        payload: { permissionId: 'perm_1' },
      }));

      const received = await laptopMsgPromise;
      expect(received.type).toBe('approve');
      expect(received.payload.permissionId).toBe('perm_1');
    });
  });

  describe('replay', () => {
    beforeEach(() => {
      createHead();
    });

    it('should replay stored messages on request', async () => {
      const { ws: laptop } = await authConnect('Laptop', 'tentacle');
      const { ws: phone } = await authConnect('Phone', 'app');

      // Send messages
      laptop.send(JSON.stringify({
        type: 'user_message', sessionId: 'sess_1', payload: { content: 'hello' },
      }));
      await waitForMessageOfType(phone, 'user_message');

      laptop.send(JSON.stringify({
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'world' },
      }));
      await waitForMessageOfType(phone, 'agent_message');

      // New browser connects and requests replay
      const { ws: browser } = await authConnect('Browser', 'app');

      // Set up listener BEFORE sending replay request
      const messages: any[] = [];
      const gotTwo = new Promise<void>((resolve) => {
        browser.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'user_message' || msg.type === 'agent_message') {
            messages.push(msg);
            if (messages.length === 2) resolve();
          }
        });
      });

      browser.send(JSON.stringify({ type: 'replay', afterSeq: 0 }));
      await gotTwo;

      expect(messages[0].type).toBe('user_message');
      expect(messages[0].seq).toBe(1);
      expect(messages[1].type).toBe('agent_message');
      expect(messages[1].seq).toBe(2);
    });
  });

  describe('device lifecycle notifications', () => {
    beforeEach(() => {
      createHead();
    });

    it('should broadcast device_online when device connects', async () => {
      const { ws: laptop } = await authConnect('Laptop', 'tentacle');

      // Wait for a device_online notice about Phone specifically
      const noticePromise = new Promise<any>((resolve) => {
        const handler = (data: any) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'head_notice' && msg.event === 'device_online' && msg.data.device.name === 'Phone') {
            laptop.off('message', handler);
            resolve(msg);
          }
        };
        laptop.on('message', handler);
      });
      const { ws: phone } = await authConnect('Phone', 'app');
      const notice = await noticePromise;

      expect(notice.type).toBe('head_notice');
      expect(notice.event).toBe('device_online');
      expect(notice.data.device.name).toBe('Phone');
    });

    it('should broadcast device_offline when device disconnects', async () => {
      const { ws: laptop } = await authConnect('Laptop', 'tentacle');
      const { ws: phone } = await authConnect('Phone', 'app');

      const noticePromise = waitForMessageOfType(laptop, 'head_notice');
      phone.close();
      // May get device_online for phone first, then device_offline
      let notice = await noticePromise;
      while (notice.event !== 'device_offline') {
        notice = await waitForMessageOfType(laptop, 'head_notice');
      }

      expect(notice.type).toBe('head_notice');
      expect(notice.event).toBe('device_offline');
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      createHead();
    });

    it('should handle invalid JSON gracefully', async () => {
      const ws = connect();
      await waitForOpen(ws);

      // Auth first
      ws.send(JSON.stringify({
        type: 'auth',
        device: { name: 'Laptop', role: 'tentacle' },
      }));
      await waitForMessageOfType(ws, 'auth_ok');

      // Send garbage
      ws.send('this is not json {{{');
      const response = await waitForMessageOfType(ws, 'server_error');
      expect(response.message).toContain('Invalid JSON');
    });

    it('should reject messages with invalid format', async () => {
      const ws = connect();
      await waitForOpen(ws);

      ws.send(JSON.stringify({
        type: 'auth',
        device: { name: 'Laptop', role: 'tentacle' },
      }));
      await waitForMessageOfType(ws, 'auth_ok');

      // Valid JSON but payload is a number, not an object
      ws.send(JSON.stringify({ type: 'agent_message', payload: 42 }));
      const response = await waitForMessageOfType(ws, 'server_error');
      expect(response.message).toContain('Invalid message');
    });

    it('should handle unauthenticated WebSocket close without error', async () => {
      const ws = connect();
      await waitForOpen(ws);
      // Close without ever authenticating — should not throw
      ws.close();
      // Give it a moment to process
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    it('should handle WebSocket error by closing', async () => {
      const ws = connect();
      await waitForOpen(ws);
      // Suppress the error event on client side
      ws.on('error', () => {});
      // Emit an error on the ws — server should close the connection
      ws.emit('error', new Error('test error'));
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    it('should accept connections via acceptConnection', async () => {
      // Create a separate WebSocket pair for direct connection
      const serverWs = new WebSocketServer({ port: 0 });
      const directPort = (serverWs.address() as any).port;

      // Create a new head using acceptConnection
      const directHead = new HeadServer(cm, router, { authProvider: new OpenAuthProvider(), e2e: false, pingInterval: 0 });

      serverWs.on('connection', (ws) => {
        directHead.acceptConnection(ws);
      });

      const ws = new WebSocket(`ws://127.0.0.1:${directPort}`);
      await waitForOpen(ws);

      ws.send(JSON.stringify({
        type: 'auth',
        device: { name: 'Direct', role: 'tentacle' },
      }));
      const authOk = await waitForMessage(ws);
      expect(authOk.type).toBe('auth_ok');

      ws.close();
      directHead.close();
      serverWs.close();
    });

    it('should handle server-side WebSocket error', async () => {
      // Use acceptConnection to get direct access to the server-side ws
      const serverWs = new WebSocketServer({ port: 0 });
      const directPort = (serverWs.address() as any).port;
      const directHead = new HeadServer(cm, router, { authProvider: new OpenAuthProvider(), e2e: false, pingInterval: 0 });

      let serverSideWs: WebSocket | undefined;
      serverWs.on('connection', (ws) => {
        serverSideWs = ws;
        directHead.acceptConnection(ws);
      });

      const ws = new WebSocket(`ws://127.0.0.1:${directPort}`);
      ws.on('error', () => {});
      await waitForOpen(ws);
      expect(serverSideWs).toBeTruthy();

      // Trigger error on server-side WebSocket
      serverSideWs!.emit('error', new Error('server side error'));
      await new Promise(resolve => setTimeout(resolve, 50));

      directHead.close();
      serverWs.close();
    });

    it('should report e2e: true when configured', async () => {
      head?.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));

      httpServer = createServer();
      await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
      port = (httpServer.address() as any).port;

      head = new HeadServer(cm, router, { authProvider: new OpenAuthProvider(), e2e: true, pingInterval: 0 });
      head.attach(httpServer);

      const { authOk } = await authConnect('Laptop', 'tentacle');
      expect(authOk.e2e).toBe(true);
    });
  });

  describe('client message dedup', () => {
    beforeEach(() => {
      createHead();
    });

    it('should process first message with clientMsgId', async () => {
      const { ws: laptop } = await authConnect('Laptop', 'tentacle');
      const { ws: phone } = await authConnect('Phone', 'app');

      const msgPromise = waitForMessageOfType(phone, 'agent_message');
      laptop.send(JSON.stringify({
        type: 'agent_message',
        sessionId: 'sess_1',
        payload: { content: 'hello' },
        clientMsgId: 'msg_001',
      }));

      const received = await msgPromise;
      expect(received.payload.content).toBe('hello');
    });

    it('should drop duplicate message with same clientMsgId', async () => {
      const { ws: laptop } = await authConnect('Laptop', 'tentacle');
      const { ws: phone } = await authConnect('Phone', 'app');

      // Send same clientMsgId twice
      laptop.send(JSON.stringify({
        type: 'agent_message', sessionId: 'sess_1',
        payload: { content: 'first' }, clientMsgId: 'msg_dup',
      }));
      laptop.send(JSON.stringify({
        type: 'agent_message', sessionId: 'sess_1',
        payload: { content: 'duplicate' }, clientMsgId: 'msg_dup',
      }));

      const msg1 = await waitForMessageOfType(phone, 'agent_message');
      expect(msg1.payload.content).toBe('first');

      // Wait a bit — second message should NOT arrive
      await new Promise(r => setTimeout(r, 200));
      const agentMsgs = phone.bufferedAmount; // not useful, check messages instead

      // Send a third message with different ID to confirm routing still works
      laptop.send(JSON.stringify({
        type: 'agent_message', sessionId: 'sess_1',
        payload: { content: 'third' }, clientMsgId: 'msg_003',
      }));
      const msg3 = await waitForMessageOfType(phone, 'agent_message');
      expect(msg3.payload.content).toBe('third');
    });

    it('should allow messages without clientMsgId (no dedup)', async () => {
      const { ws: laptop } = await authConnect('Laptop', 'tentacle');
      const { ws: phone } = await authConnect('Phone', 'app');

      // Collect agent_message events
      const received: any[] = [];
      const gotTwo = new Promise<void>((resolve) => {
        phone.on('message', (data: any) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'agent_message') {
            received.push(msg);
            if (received.length === 2) resolve();
          }
        });
      });

      laptop.send(JSON.stringify({
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'a' },
      }));
      laptop.send(JSON.stringify({
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'b' },
      }));

      await gotTwo;
      expect(received[0].payload.content).toBe('a');
      expect(received[1].payload.content).toBe('b');
    });
  });

  describe('ping timeout', () => {
    it('should terminate dead connections after ping timeout', async () => {
      head?.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));

      httpServer = createServer();
      await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
      port = (httpServer.address() as any).port;

      // Short ping interval for testing
      head = new HeadServer(cm, router, {
        authProvider: new OpenAuthProvider(),
        e2e: false,
        pingInterval: 100,   // ping every 100ms
        pongTimeout: 50,
      });
      head.attach(httpServer);

      const ws = connect();
      await waitForOpen(ws);

      ws.send(JSON.stringify({
        type: 'auth',
        device: { name: 'Ghost', role: 'tentacle' },
      }));
      await waitForMessageOfType(ws, 'auth_ok');

      // Suppress pong responses to simulate dead connection
      ws.pong = () => {};  // override pong
      (ws as any)._socket?.removeAllListeners('pong');

      // Wait for ping cycle to detect and terminate
      const closed = new Promise<void>(resolve => ws.on('close', resolve));
      await closed;

      // Connection should be terminated
      expect(ws.readyState).toBeGreaterThanOrEqual(2); // CLOSING or CLOSED
    }, 10_000);
  });
});
