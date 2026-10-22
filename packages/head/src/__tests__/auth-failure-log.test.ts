/**
 * Log audit 2026-10-22 (b): auth failures and sockets closed before auth were
 * only logged at debug, so scanning could not be ruled out. They now log at
 * info with ip / method / reason, capped per IP (LogThrottle).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { LogThrottle } from '../logger.js';
import { createTestEnv, type TestEnv } from './integration-helpers.js';
import { captureLogs, silenceLogs, type CapturingLogger } from './log-capture.js';

describe('LogThrottle', () => {
  it('caps lines per key and in total per window, then reports what it dropped', () => {
    let now = 0;
    const throttle = new LogThrottle(2, 3, 60_000, () => now);
    expect(throttle.take('a')).toEqual({});
    expect(throttle.take('a')).toEqual({});
    expect(throttle.take('a')).toBeNull();
    expect(throttle.take('b')).toEqual({});
    expect(throttle.take('c')).toBeNull(); // total cap
    now = 60_000;
    expect(throttle.take('a')).toEqual({ suppressed: 1 });
    expect(throttle.take('c')).toEqual({ suppressed: 1 });
    expect(throttle.take('a')).toEqual({});
  });
});

describe('auth failure and pre-auth close logging', () => {
  let env: TestEnv;
  let logs: CapturingLogger;

  beforeEach(async () => {
    env = await createTestEnv();
    logs = captureLogs();
  });

  afterEach(async () => {
    silenceLogs();
    await env.cleanup();
  });

  async function open(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    return ws;
  }

  function next(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const onMessage = (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) { ws.off('message', onMessage); resolve(msg); }
      };
      ws.on('message', onMessage);
    });
  }

  const waitUntil = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('logs a failed challenge at info with ip, method, device and reason', async () => {
    const ws = await open();
    const error = next(ws, 'auth_error');
    ws.send(JSON.stringify({ type: 'auth', auth: { method: 'challenge', deviceId: 'dev_unknown' }, device: { name: 'x', role: 'app' } }));
    expect((await error).code).toBe('unknown_device');
    const [line] = logs.find('Auth failed');
    expect(line).toMatchObject({
      level: 'info',
      data: { code: 'unknown_device', ip: '127.0.0.1', method: 'challenge', deviceId: 'dev_unknown', reason: 'Unknown device' },
    });
    ws.close();
  });

  it('bounds every client-supplied field of an auth log line (1 MB device id / method)', async () => {
    const huge = 'd'.repeat(1024 * 1024);
    const ws = await open();
    const error = next(ws, 'auth_error');
    ws.send(JSON.stringify({ type: 'auth', auth: { method: 'challenge', deviceId: huge }, device: { name: 'x', role: 'app' } }));
    expect((await error).code).toBe('unknown_device');
    const [line] = logs.find('Auth failed');
    expect(line.data.deviceId).toBe(`${'d'.repeat(64)}…(${huge.length} chars)`);
    ws.close();

    const ws2 = await open();
    const error2 = next(ws2, 'auth_error');
    ws2.send(JSON.stringify({ type: 'auth', auth: { method: huge }, device: { name: 'x', role: 'app', deviceId: huge } }));
    await error2;
    const failed = logs.find('Auth failed')[1];
    for (const value of Object.values(failed.data)) {
      expect(String(value).length).toBeLessThan(200);
    }
    ws2.close();
    await new Promise<void>((resolve) => ws2.on('close', () => resolve()));
    await waitUntil(() => logs.find('WebSocket closed before auth').length >= 2);
    for (const closed of logs.find('WebSocket closed before auth')) {
      for (const value of Object.values(closed.data)) expect(String(value).length).toBeLessThan(200);
    }
    expect(JSON.stringify(logs.lines).length).toBeLessThan(20_000);
  });

  it('logs a socket that closes without signing in, capped per IP', async () => {
    for (let i = 0; i < 7; i++) {
      const ws = await open();
      ws.close(1000, 'bye');
      await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    }
    await waitUntil(() => env.server.clients.size === 0);
    const lines = logs.find('WebSocket closed before auth');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({ level: 'info', data: { ip: '127.0.0.1', closeCode: 1000, closeReason: 'bye' } });
    expect(typeof lines[0].data.afterMs).toBe('number');
  });
});
