/**
 * Delivery assurance integration tests.
 *
 * Verifies the relay-side delivery tracking mechanism:
 *  - Outbound messages from head carry a per-connection `relaySeq`.
 *  - Peers piggyback `ack` on any outbound message to prune the in-flight buffer.
 *  - Head retries unacked messages after RETRY_AFTER_MS via forceRetryPass().
 *  - Old clients (no ack support) are detected and skipped from retries.
 *  - Duplicate retries are silently deduped on the receiver side.
 *
 * These tests use the existing integration-helpers.ts pattern but invoke
 * `forceRetryPass()` directly instead of waiting for the timer, so they
 * complete in well under a second each.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createTestEnv, connectDevice, type TestEnv, type MockDevice } from './integration-helpers.js';

// Helper: a manually-controlled mock device that does NOT auto-ack.
// (The default connectDevice helper has no logic to send ack — it just sends
// whatever the test sends. Good — we can mix tracked and non-tracked behavior.)
async function ackEnabledDevice(env: TestEnv, name: string, role: 'tentacle' | 'app'): Promise<MockDevice & {
  lastRelaySeq: number;
  ackHighest: () => void;
  setAutoAck: (on: boolean) => void;
}> {
  const dev = await connectDevice(env.port, name, role);
  let lastRelaySeq = 0;
  let autoAck = true;

  // Wrap the underlying ws to track inbound relaySeq and optionally auto-ack.
  // We hook the 'message' listener directly on the ws.
  dev.ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (typeof msg.relaySeq === 'number' && msg.relaySeq > lastRelaySeq) {
        lastRelaySeq = msg.relaySeq;
      }
    } catch { /* ignore */ }
  });

  return {
    ...dev,
    get lastRelaySeq() { return lastRelaySeq; },
    ackHighest() {
      if (dev.ws.readyState !== WebSocket.OPEN) return;
      dev.ws.send(JSON.stringify({ type: 'ping', ack: lastRelaySeq }));
    },
    setAutoAck(on: boolean) {
      autoAck = on;
      if (autoAck) {
        // Periodically ack — simulates the real client ping cadence at 50ms
        // for fast tests.
        const t = setInterval(() => {
          if (!autoAck || dev.ws.readyState !== WebSocket.OPEN) {
            clearInterval(t);
            return;
          }
          dev.ws.send(JSON.stringify({ type: 'ping', ack: lastRelaySeq }));
        }, 50);
      }
    },
  };
}

describe('Delivery assurance — relaySeq stamping', () => {
  let env: TestEnv;

  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('stamps forwarded broadcasts with monotonic relaySeq per connection', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');

    // Tentacle sends three broadcasts in sequence.
    for (let i = 0; i < 3; i++) {
      tentacle.send({ type: 'broadcast', blob: `b${i}`, keys: { [app.deviceId]: 'k' } });
    }

    const received = await app.waitForN('broadcast', 3, 2000);
    expect(received.map(m => m.relaySeq)).toEqual([1, 2, 3]);
    // Original payload preserved.
    expect(received.map(m => m.blob)).toEqual(['b0', 'b1', 'b2']);
  });

  it('stamps forwarded unicasts with monotonic relaySeq', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');
    // Drain the device_joined that tentacle gets when app connects.
    await tentacle.waitFor('device_joined', 2000);
    const startSeq = env.server.getDeliveryState(tentacle.deviceId)!.relaySeqCounter;

    app.send({ type: 'unicast', to: tentacle.deviceId, blob: 'u1', keys: { [tentacle.deviceId]: 'k' } });
    app.send({ type: 'unicast', to: tentacle.deviceId, blob: 'u2', keys: { [tentacle.deviceId]: 'k' } });

    const got = await tentacle.waitForN('unicast', 2, 2000);
    expect(got.map(m => m.relaySeq)).toEqual([startSeq + 1, startSeq + 2]);
    expect(got.map(m => m.blob)).toEqual(['u1', 'u2']);
  });

  it('strips sender-side relaySeq/ack from forwarded envelopes (per-hop fields)', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');

    // Tentacle sends a broadcast with its own relaySeq=99 / ack=42.
    // Those are tentacle→head fields; head must NOT forward them as-is to the app.
    tentacle.send({
      type: 'broadcast',
      blob: 'x',
      keys: { [app.deviceId]: 'k' },
      relaySeq: 99,
      ack: 42,
    });

    const got = await app.waitFor('broadcast', 2000);
    // The relaySeq the app sees should be head→app's own counter (1), not 99.
    expect(got.relaySeq).toBe(1);
    // ack on the forwarded message reflects head's lastReceivedRelaySeq from
    // the app (still 0 at this point — app has not sent any tracked traffic).
    expect(got.ack).toBeUndefined();
  });

  it('uses independent counters for different recipients', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app1 = await connectDevice(env.port, 'Phone1', 'app');
    const app2 = await connectDevice(env.port, 'Phone2', 'app');
    // Drain device_joined broadcasts: each new device causes broadcasts to others.
    // After all connect, app1 received device_joined for app2 (relaySeq=1 on head→app1).
    // app2 received device_joined for ... none. (it joined last)
    // Track each app's current counter before the test broadcast.
    const startApp1 = env.server.getDeliveryState(app1.deviceId)!.relaySeqCounter;
    const startApp2 = env.server.getDeliveryState(app2.deviceId)!.relaySeqCounter;

    tentacle.send({ type: 'broadcast', blob: 'b', keys: { [app1.deviceId]: 'k1', [app2.deviceId]: 'k2' } });

    const [m1, m2] = await Promise.all([
      app1.waitFor('broadcast', 2000),
      app2.waitFor('broadcast', 2000),
    ]);
    // Each app's counter advances by exactly 1 from its starting point —
    // counters are independent per connection.
    expect(m1.relaySeq).toBe(startApp1 + 1);
    expect(m2.relaySeq).toBe(startApp2 + 1);
  });

  it('control messages (device_joined) are stamped with relaySeq', async () => {
    const app = await connectDevice(env.port, 'Phone', 'app');
    // app connected first — when tentacle joins, head sends device_joined to app
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');

    const joined = await app.waitFor('device_joined', 2000);
    expect(joined.relaySeq).toBe(1);
    expect((joined.device as { id: string }).id).toBe(tentacle.deviceId);
  });
});

describe('Delivery assurance — ack pruning', () => {
  let env: TestEnv;

  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('inFlight buffer grows for unacked messages and prunes on ack', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');

    // Send 3 broadcasts — head→app side accumulates 3 in-flight entries.
    for (let i = 0; i < 3; i++) {
      tentacle.send({ type: 'broadcast', blob: `b${i}`, keys: { [app.deviceId]: 'k' } });
    }
    await app.waitForN('broadcast', 3, 2000);

    let appState = env.server.getDeliveryState(app.deviceId);
    expect(appState).toBeDefined();
    expect(appState!.relaySeqCounter).toBe(3);
    expect(appState!.inFlightCount).toBe(3);
    expect(appState!.ackSupported).toBe(false);
    expect(appState!.lastAckedSeq).toBe(0);

    // App acks up to 2 — head should prune entries 1 and 2, leaving 3 in-flight.
    app.send({ type: 'ping', ack: 2 });
    // Wait briefly for head to process.
    await new Promise(r => setTimeout(r, 50));

    appState = env.server.getDeliveryState(app.deviceId);
    expect(appState!.ackSupported).toBe(true);
    expect(appState!.lastAckedSeq).toBe(2);
    expect(appState!.inFlightCount).toBe(1);

    // App acks up to 3 — buffer empty.
    app.send({ type: 'ping', ack: 3 });
    await new Promise(r => setTimeout(r, 50));

    appState = env.server.getDeliveryState(app.deviceId);
    expect(appState!.lastAckedSeq).toBe(3);
    expect(appState!.inFlightCount).toBe(0);
  });

  it('ack: 0 still flips ackSupported (presence of field is the gate)', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');

    tentacle.send({ type: 'broadcast', blob: 'b', keys: { [app.deviceId]: 'k' } });
    await app.waitFor('broadcast', 2000);

    app.send({ type: 'ping', ack: 0 });
    await new Promise(r => setTimeout(r, 50));

    const state = env.server.getDeliveryState(app.deviceId)!;
    expect(state.ackSupported).toBe(true);
    expect(state.lastAckedSeq).toBe(0); // Nothing pruned.
    expect(state.inFlightCount).toBe(1);
  });

  it('non-decreasing lastAckedSeq — stale acks are ignored', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');

    for (let i = 0; i < 3; i++) {
      tentacle.send({ type: 'broadcast', blob: `b${i}`, keys: { [app.deviceId]: 'k' } });
    }
    await app.waitForN('broadcast', 3, 2000);

    app.send({ type: 'ping', ack: 2 });
    await new Promise(r => setTimeout(r, 30));
    app.send({ type: 'ping', ack: 1 }); // stale — should not regress
    await new Promise(r => setTimeout(r, 30));

    const state = env.server.getDeliveryState(app.deviceId)!;
    expect(state.lastAckedSeq).toBe(2);
    expect(state.inFlightCount).toBe(1);
  });
});

describe('Delivery assurance — retry behavior', () => {
  let env: TestEnv;

  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('re-sends unacked messages on retry pass', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');

    // App declares ack support immediately so head knows it can retry.
    app.send({ type: 'ping', ack: 0 });
    await new Promise(r => setTimeout(r, 30));
    expect(env.server.getDeliveryState(app.deviceId)!.ackSupported).toBe(true);

    // Send one broadcast; app receives it (relaySeq=1).
    tentacle.send({ type: 'broadcast', blob: 'original', keys: { [app.deviceId]: 'k' } });
    const firstCopy = await app.waitFor('broadcast', 2000);
    expect(firstCopy.relaySeq).toBe(1);

    // App does NOT ack. Force-age the in-flight entry by overwriting sentAt
    // (we don't have a way to do that without exposing internals — instead,
    // we wait long enough that RETRY_AFTER_MS passes, then force retry).
    await new Promise(r => setTimeout(r, 5100));
    env.server.forceRetryPass();

    // App should receive a second copy with the same relaySeq.
    const retryCopy = await app.waitFor('broadcast', 2000);
    expect(retryCopy.relaySeq).toBe(1);
    expect(retryCopy.blob).toBe('original');

    const state = env.server.getDeliveryState(app.deviceId)!;
    expect(state.inFlightCount).toBe(1);
  }, 15000);

  it('does not retry for clients that have not demonstrated ack support', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'OldPhone', 'app');

    // App never sends an ack field.
    tentacle.send({ type: 'broadcast', blob: 'b', keys: { [app.deviceId]: 'k' } });
    await app.waitFor('broadcast', 2000);

    // Even after retry threshold, force-running retry pass produces nothing.
    await new Promise(r => setTimeout(r, 5100));
    const messagesBefore = app.messages.length;
    env.server.forceRetryPass();
    await new Promise(r => setTimeout(r, 50));

    expect(app.messages.length).toBe(messagesBefore);
    expect(env.server.getDeliveryState(app.deviceId)!.ackSupported).toBe(false);
  }, 15000);

  it('closes connection after MAX_RETRIES exceeded', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');

    // Flip ack support but never actually ack the data message.
    app.send({ type: 'ping', ack: 0 });
    await new Promise(r => setTimeout(r, 30));

    tentacle.send({ type: 'broadcast', blob: 'doomed', keys: { [app.deviceId]: 'k' } });
    await app.waitFor('broadcast', 2000);

    // Track when the connection closes.
    let closed = false;
    app.ws.on('close', () => { closed = true; });

    // Wait past RETRY_AFTER_MS, then force 4 retry passes (3 retries + 1 to trigger close).
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 5100));
      env.server.forceRetryPass();
      if (closed) break;
    }

    await new Promise(r => setTimeout(r, 200));
    expect(closed).toBe(true);
    // Connection removed from head's map.
    expect(env.server.getDeliveryState(app.deviceId)).toBeUndefined();
  }, 30000);
});

describe('Delivery assurance — head dedup', () => {
  let env: TestEnv;

  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('drops duplicate relaySeq messages received from peer', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');

    // App sends a unicast to tentacle with relaySeq=1.
    app.send({
      type: 'unicast',
      to: tentacle.deviceId,
      blob: 'first',
      keys: { [tentacle.deviceId]: 'k' },
      relaySeq: 1,
    });
    await tentacle.waitFor('unicast', 2000);

    // App "retries" the same unicast (same relaySeq).
    app.send({
      type: 'unicast',
      to: tentacle.deviceId,
      blob: 'first',
      keys: { [tentacle.deviceId]: 'k' },
      relaySeq: 1,
    });

    // Tentacle should NOT receive a second copy from head — head dedups by
    // inbound relaySeq from app. Wait long enough to be confident.
    await new Promise(r => setTimeout(r, 100));
    const unicasts = tentacle.messages.filter(m => m.type === 'unicast');
    expect(unicasts.length).toBe(1);

    // Head's tracking of inbound from app records it once.
    const state = env.server.getDeliveryState(app.deviceId)!;
    expect(state.lastReceivedRelaySeq).toBe(1);
  });
});

describe('Delivery assurance — head→peer ack piggyback', () => {
  let env: TestEnv;

  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('head includes ack in outbound forwarded messages after receiving from peer', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    const app = await connectDevice(env.port, 'Phone', 'app');
    await tentacle.waitFor('device_joined', 2000);
    const startSeq = env.server.getDeliveryState(tentacle.deviceId)!.relaySeqCounter;

    // Tentacle sends a broadcast with relaySeq=5 — head records lastReceivedRelaySeq=5 for tentacle.
    tentacle.send({
      type: 'broadcast',
      blob: 'b',
      keys: { [app.deviceId]: 'k' },
      relaySeq: 5,
    });
    await app.waitFor('broadcast', 2000);

    // App sends a unicast back to tentacle. Head's outbound to tentacle should
    // carry ack=5 (= head's lastReceivedRelaySeq from tentacle).
    app.send({
      type: 'unicast',
      to: tentacle.deviceId,
      blob: 'reply',
      keys: { [tentacle.deviceId]: 'k' },
    });

    const got = await tentacle.waitFor('unicast', 2000);
    expect(got.ack).toBe(5);
    expect(got.relaySeq).toBe(startSeq + 1); // next tracked send to tentacle
  });

  it('pong includes head ack', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');

    tentacle.send({
      type: 'broadcast',
      blob: 'b',
      keys: {},
      relaySeq: 7,
    });
    await new Promise(r => setTimeout(r, 30));

    tentacle.send({ type: 'ping' });
    const pong = await tentacle.waitFor('pong', 2000);
    expect(pong.ack).toBe(7);
  });
});
