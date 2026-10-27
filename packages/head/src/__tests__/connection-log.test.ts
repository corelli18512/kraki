/**
 * Log audit 2026-10-22 (c): a connection dropped for a missed pong logged no
 * 'Device disconnected', and connect / disconnect lines did not say what the
 * device is or how long it was online.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, connectDevice, type TestEnv } from './integration-helpers.js';
import { captureLogs, silenceLogs, type CapturingLogger } from './log-capture.js';

describe('device connect / disconnect log lines', () => {
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

  const waitUntil = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('a pong timeout logs Device disconnected with role, kind and online time', async () => {
    const app = await connectDevice(env.port, 'Phone', 'app', { kind: 'ios' });
    const [auth] = logs.find('Device authenticated (via backend)');
    expect(auth.data).toMatchObject({ deviceId: app.deviceId, role: 'app', kind: 'ios' });

    await new Promise((r) => setTimeout(r, 20));
    env.server.simulatePingSent(app.deviceId);
    env.server.forcePingPass();

    const lines = logs.find('Device disconnected');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      data: { deviceId: app.deviceId, role: 'app', kind: 'ios', closeReason: 'pong_timeout', terminated: true },
    });
    expect(lines[0].data.onlineMs as number).toBeGreaterThanOrEqual(0);
    // The socket's own close event does not log it a second time.
    await waitUntil(() => env.server.clients.size === 0);
    expect(logs.find('Device disconnected')).toHaveLength(1);
  });

  it('a normal close logs role, kind, close code and online time', async () => {
    const tentacle = await connectDevice(env.port, 'Mac', 'tentacle', { kind: 'desktop' });
    tentacle.ws.close(1000, 'quit');
    await waitUntil(() => logs.find('Device disconnected').length > 0);
    const [line] = logs.find('Device disconnected');
    expect(line.data).toMatchObject({ deviceId: tentacle.deviceId, role: 'tentacle', kind: 'desktop', closeCode: 1000, closeReason: 'quit' });
    expect(typeof line.data.onlineMs).toBe('number');
  });
});
