import { describe, expect, it, vi } from 'vitest';
import type { SessionSubscriptionSetMessage } from '@kraki/protocol';
import { SessionSubscriptionController } from './session-subscription';

function ack(deviceId: string, sessionId: string | null): SessionSubscriptionSetMessage {
  return {
    type: 'session_subscription_set', deviceId, seq: 1, timestamp: '',
    payload: sessionId === null
      ? { accepted: true, sessionId: null, snapshot: null }
      : {
          accepted: true,
          sessionId,
          snapshot: {
            digest: { id: sessionId, agent: 'pi', state: 'active', mode: 'execute', lastSeq: 3, readSeq: 0, messageCount: 3, createdAt: '' },
            spineHeadSeq: 3,
            card: { draft: 'live', action: null },
          },
        },
  };
}

function setup(routes: Record<string, string> = { A: 'T1', B: 'T1', C: 'T1' }) {
  let connected = true;
  const sends: Array<[string, string | null]> = [];
  const applySnapshot = vi.fn();
  const reportError = vi.fn();
  const controller = new SessionSubscriptionController({
    isConnected: () => connected,
    resolveTentacle: (sessionId) => routes[sessionId],
    send: async (tentacleId, sessionId) => { sends.push([tentacleId, sessionId]); return true; },
    applySnapshot,
    reportError,
  });
  return { controller, sends, applySnapshot, reportError, disconnect: () => { connected = false; controller.onDisconnected(); } };
}

describe('SessionSubscriptionController', () => {
  it('waits for the post-auth session_list barrier', async () => {
    const { controller, sends } = setup();
    controller.setDesired('A');
    expect(sends).toEqual([]);
    controller.onSessionList('T1');
    await Promise.resolve();
    expect(sends).toEqual([['T1', 'A']]);
  });

  it('establishes liveReady only after the matching snapshot ACK', async () => {
    const { controller, applySnapshot } = setup();
    controller.setDesired('A'); controller.onSessionList('T1'); await Promise.resolve();
    expect(controller.liveReady).toBe(false);
    controller.onAck(ack('T1', 'A'));
    expect(controller.liveReady).toBe(true);
    expect(controller.acceptsLive('A')).toBe(true);
    expect(controller.acceptsLive('B')).toBe(false);
    expect(applySnapshot).toHaveBeenCalledOnce();
  });

  it('stops accepting A live frames before the same-tentacle B ACK', async () => {
    const { controller, sends } = setup();
    controller.setDesired('A'); controller.onSessionList('T1'); await Promise.resolve(); controller.onAck(ack('T1', 'A'));
    expect(controller.acceptsLive('A')).toBe(true);
    controller.setDesired('B'); await Promise.resolve();
    expect(controller.acceptsLive('A')).toBe(false);
    expect(controller.acceptsLive('B')).toBe(false);
    expect(sends).toEqual([['T1', 'A'], ['T1', 'B']]);
  });

  it('coalesces rapid A→B→C while one request is in flight', async () => {
    const { controller, sends } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); await Promise.resolve();
    controller.setDesired('B'); controller.setDesired('C');
    controller.onAck(ack('T1', 'A')); await Promise.resolve();
    expect(sends).toEqual([['T1', 'A'], ['T1', 'C']]);
  });

  it('unsubscribes the old tentacle before subscribing on a new tentacle', async () => {
    const { controller, sends } = setup({ A: 'T1', B: 'T2' });
    controller.onSessionList('T1'); controller.onSessionList('T2');
    controller.setDesired('A'); await Promise.resolve(); controller.onAck(ack('T1', 'A'));
    controller.setDesired('B'); await Promise.resolve();
    expect(sends.at(-1)).toEqual(['T1', null]);
    controller.onAck(ack('T1', null)); await Promise.resolve();
    expect(sends.at(-1)).toEqual(['T2', 'B']);
  });

  it('ignores a stale ACK that does not match the in-flight desired request', async () => {
    const { controller, applySnapshot } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); await Promise.resolve();
    controller.onAck(ack('T1', 'B'));
    expect(controller.liveReady).toBe(false);
    expect(applySnapshot).not.toHaveBeenCalled();
    controller.onAck(ack('T1', 'A'));
    expect(controller.liveReady).toBe(true);
  });

  it('retains desired across reconnect but requires a new barrier and ACK', async () => {
    const { controller, sends, disconnect } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); await Promise.resolve(); controller.onAck(ack('T1', 'A'));
    disconnect();
    expect(controller.desired).toBe('A');
    expect(controller.liveReady).toBe(false);
    controller.onSessionList('T1');
    expect(sends).toHaveLength(1); // disconnected host does not send
  });
});
