/**
 * device_pending liveness broadcast tests.
 *
 * Verifies:
 *  - Pong arrives before grace expires → no device_pending emitted.
 *  - Pong arrives after grace expires → device_pending then device_joined re-promotion.
 *  - No pong at all → device_pending then device_left on next ping pass.
 *
 * Uses simulatePingSent() to avoid ws library auto-pong on protocol-level ping,
 * which would make it impossible to test overdue scenarios.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestEnv, connectDevice, type TestEnv } from './integration-helpers.js';

describe('device_pending liveness broadcast', () => {
  let env: TestEnv;

  afterEach(async () => { await env.cleanup(); });

  function messagesOfType(messages: Record<string, unknown>[], type: string): Record<string, unknown>[] {
    return messages.filter(m => m.type === type);
  }

  // App connects first so it receives device_joined when tentacle connects.
  async function setupPair() {
    const app = await connectDevice(env.port, 'Phone', 'app');
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    await app.waitFor('device_joined', 2000);
    return { app, tentacle };
  }

  it('pong before grace → no device_pending emitted', async () => {
    env = await createTestEnv();
    const { app, tentacle } = await setupPair();

    // Simulate ping sent to tentacle (sets isAlive=false, starts grace timer)
    env.server.simulatePingSent(tentacle.deviceId);

    // Tentacle responds with JSON pong before grace expires
    tentacle.send({ type: 'pong' });
    await new Promise(r => setTimeout(r, 50));

    // Run retry pass (includes pending check) — pong arrived, so no pending
    env.server.forceRetryPass();
    await new Promise(r => setTimeout(r, 100));

    expect(messagesOfType(app.messages, 'device_pending')).toHaveLength(0);

    tentacle.close();
    app.close();
  });

  it('pong after grace → device_pending then device_joined re-promotion', async () => {
    env = await createTestEnv();
    const { app, tentacle } = await setupPair();

    // Simulate ping sent to tentacle
    env.server.simulatePingSent(tentacle.deviceId);

    // Expire the grace timer (simulates 8s passing without pong)
    env.server.expirePongGrace(tentacle.deviceId);

    // Retry pass detects overdue → broadcasts device_pending
    env.server.forceRetryPass();

    const pending = await app.waitFor('device_pending', 2000);
    expect(pending.deviceId).toBe(tentacle.deviceId);

    // Late pong arrives → re-promotes via device_joined
    tentacle.send({ type: 'pong' });

    const rejoin = await app.waitFor('device_joined', 2000);
    expect((rejoin.device as { id: string }).id).toBe(tentacle.deviceId);

    tentacle.close();
    app.close();
  });

  it('no pong → device_pending then device_left on next ping pass', async () => {
    env = await createTestEnv();
    const { app, tentacle } = await setupPair();

    // Simulate ping sent to tentacle
    env.server.simulatePingSent(tentacle.deviceId);

    // Grace expires
    env.server.expirePongGrace(tentacle.deviceId);
    env.server.forceRetryPass();

    const pending = await app.waitFor('device_pending', 2000);
    expect(pending.deviceId).toBe(tentacle.deviceId);

    // No pong sent. forcePingPass sees isAlive=false → terminates connection.
    env.server.forcePingPass();

    const left = await app.waitFor('device_left', 2000);
    expect(left.deviceId).toBe(tentacle.deviceId);

    app.close();
  });

  it('device_pending is not sent to the pending device itself', async () => {
    env = await createTestEnv();
    const { app, tentacle } = await setupPair();

    env.server.simulatePingSent(tentacle.deviceId);
    env.server.expirePongGrace(tentacle.deviceId);
    env.server.forceRetryPass();

    await app.waitFor('device_pending', 2000);
    await new Promise(r => setTimeout(r, 100));

    // Tentacle should NOT have received device_pending about itself
    expect(messagesOfType(tentacle.messages, 'device_pending')).toHaveLength(0);

    // Recover so cleanup doesn't hang
    tentacle.send({ type: 'pong' });
    await new Promise(r => setTimeout(r, 50));

    tentacle.close();
    app.close();
  });

  it('multiple healthy cycles then one overdue → exactly one device_pending', async () => {
    env = await createTestEnv();
    const { app, tentacle } = await setupPair();

    // Cycle 1: ping → pong promptly → no pending
    env.server.simulatePingSent(tentacle.deviceId);
    tentacle.send({ type: 'pong' });
    await new Promise(r => setTimeout(r, 50));
    env.server.forceRetryPass();

    // Cycle 2: same
    env.server.simulatePingSent(tentacle.deviceId);
    tentacle.send({ type: 'pong' });
    await new Promise(r => setTimeout(r, 50));
    env.server.forceRetryPass();

    // Cycle 3: grace expires → pending
    env.server.simulatePingSent(tentacle.deviceId);
    env.server.expirePongGrace(tentacle.deviceId);
    env.server.forceRetryPass();

    await app.waitFor('device_pending', 2000);
    await new Promise(r => setTimeout(r, 100));

    // Exactly one device_pending across all cycles
    expect(messagesOfType(app.messages, 'device_pending')).toHaveLength(1);

    // Recover
    tentacle.send({ type: 'pong' });
    await new Promise(r => setTimeout(r, 50));

    tentacle.close();
    app.close();
  });
});
