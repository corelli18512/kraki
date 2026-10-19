import { describe, expect, it, vi } from 'vitest';
import type { SessionSubscriptionSetMessage } from '@kraki/protocol';
import { SessionSubscriptionController } from './session-subscription';

function ack(deviceId: string, sessionId: string | null, requestId?: string): SessionSubscriptionSetMessage {
  return {
    type: 'session_subscription_set', deviceId, seq: 1, timestamp: '',
    payload: sessionId === null
      ? { accepted: true, sessionId: null, snapshot: null, requestId }
      : {
          accepted: true,
          sessionId,
          requestId,
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
  const requestIds: string[] = [];
  const applySnapshot = vi.fn();
  const reportError = vi.fn();
  const controller = new SessionSubscriptionController({
    isConnected: () => connected,
    resolveTentacle: (sessionId) => routes[sessionId],
    send: async (tentacleId, sessionId, requestId) => {
      sends.push([tentacleId, sessionId]); requestIds.push(requestId); return true;
    },
    applySnapshot,
    reportError,
  });
  return {
    controller, sends, requestIds, applySnapshot, reportError,
    disconnect: () => { connected = false; controller.onDisconnected(); },
    reconnect: () => { connected = true; controller.resume(); },
  };
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
    const { controller, sends, requestIds, applySnapshot } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); await Promise.resolve();
    controller.setDesired('B'); controller.setDesired('C');
    controller.onAck(ack('T1', 'A', requestIds[0])); await Promise.resolve();
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(controller.confirmed).toBeNull();
    expect(controller.acceptsLive('A')).toBe(false);
    expect(controller.acceptsLive('C')).toBe(false);
    expect(controller.liveReady).toBe(false);
    expect(sends).toEqual([['T1', 'A'], ['T1', 'C']]);
    controller.onAck(ack('T1', 'C', requestIds[1]));
    expect(applySnapshot).toHaveBeenCalledOnce();
    expect(controller.confirmed).toBe('C');
    expect(controller.liveReady).toBe(true);
    expect(controller.acceptsLive('C')).toBe(true);
    expect(controller.acceptsLive('A')).toBe(false);
  });

  it('also suppresses obsolete snapshots from older Tentacles without an echoed request id', () => {
    const { controller, sends, applySnapshot } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); controller.setDesired('C');
    controller.onAck(ack('T1', 'A'));
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(controller.acceptsLive('A')).toBe(false);
    expect(sends).toEqual([['T1', 'A'], ['T1', 'C']]);
    controller.onAck(ack('T1', 'C'));
    expect(controller.liveReady).toBe(true);
    expect(applySnapshot).toHaveBeenCalledOnce();
  });

  it('releases obsolete acknowledged ownership before a cross-tentacle replacement', () => {
    const { controller, sends, requestIds, applySnapshot } = setup({ A: 'T1', B: 'T2', C: 'T2' });
    controller.onSessionList('T1'); controller.onSessionList('T2');
    controller.setDesired('A'); controller.setDesired('B'); controller.setDesired('C');
    controller.onAck(ack('T1', 'A', requestIds[0]));
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(controller.acceptsLive('A')).toBe(false);
    expect(controller.confirmed).toBeNull();
    expect(sends).toEqual([['T1', 'A'], ['T1', null]]);
    controller.onAck(ack('T1', null, 'wrong-release-id'));
    expect(sends).toHaveLength(2);
    controller.onAck(ack('T1', null, requestIds[1]));
    expect(sends).toEqual([['T1', 'A'], ['T1', null], ['T2', 'C']]);
    controller.onAck(ack('T2', 'C', requestIds[2]));
    expect(controller.liveReady).toBe(true);
    expect(controller.acceptsLive('C')).toBe(true);
    expect(applySnapshot).toHaveBeenCalledOnce();
  });

  it('releases an obsolete successful ACK when the page now desires null', () => {
    const { controller, sends, requestIds, applySnapshot } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); controller.setDesired(null);
    controller.onAck(ack('T1', 'A', requestIds[0]));
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(controller.confirmed).toBeNull();
    expect(controller.acceptsLive('A')).toBe(false);
    expect(controller.liveReady).toBe(false);
    expect(sends).toEqual([['T1', 'A'], ['T1', null]]);
    controller.onAck(ack('T1', null, requestIds[1]));
    controller.resume();
    expect(sends).toHaveLength(2);
  });

  it('accepts a matching A ACK after A→B→A without inventing a navigation epoch', () => {
    const { controller, sends, requestIds, applySnapshot } = setup();
    controller.onSessionList('T1'); controller.setDesired('A');
    controller.setDesired('B'); controller.setDesired('A');
    controller.onAck(ack('T1', 'A', requestIds[0]));
    expect(sends).toEqual([['T1', 'A']]);
    expect(applySnapshot).toHaveBeenCalledOnce();
    expect(controller.confirmed).toBe('A');
    expect(controller.liveReady).toBe(true);
    expect(controller.acceptsLive('A')).toBe(true);
  });

  it.each(['device', 'session', 'request'] as const)('ignores a wrong %s identity before processing the obsolete matching ACK', (wrong) => {
    const { controller, sends, requestIds, applySnapshot } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); controller.setDesired('C');
    controller.onAck(ack(wrong === 'device' ? 'T2' : 'T1', wrong === 'session' ? 'B' : 'A', wrong === 'request' ? 'wrong-id' : requestIds[0]));
    expect(sends).toEqual([['T1', 'A']]);
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(controller.acceptsLive('A')).toBe(false);
    controller.onAck(ack('T1', 'A', requestIds[0]));
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(controller.acceptsLive('A')).toBe(false);
    expect(sends).toEqual([['T1', 'A'], ['T1', 'C']]);
  });

  it('invalidates an old flight on disconnect and requires fresh barrier/request identity on reconnect', () => {
    const { controller, sends, requestIds, applySnapshot, disconnect, reconnect } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); controller.setDesired('C');
    const oldAck = ack('T1', 'A', requestIds[0]);
    disconnect(); controller.onAck(oldAck);
    expect(controller.desired).toBe('C');
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(controller.acceptsLive('A')).toBe(false);
    reconnect();
    expect(sends).toHaveLength(1);
    controller.onSessionList('T1');
    expect(sends).toEqual([['T1', 'A'], ['T1', 'C']]);
    controller.onAck(oldAck);
    expect(applySnapshot).not.toHaveBeenCalled();
    controller.onAck(ack('T1', 'C', requestIds[1]));
    expect(controller.liveReady).toBe(true);
    expect(applySnapshot).toHaveBeenCalledOnce();
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

  it('reassures after the tentacle reconnects while the Arm stays connected', async () => {
    const { controller, sends } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); await Promise.resolve(); controller.onAck(ack('T1', 'A'));
    expect(controller.acceptsLive('A')).toBe(true);

    controller.onTentacleAuthorityReset('T1');
    expect(controller.acceptsLive('A')).toBe(false);
    controller.onSessionList('T1');
    await Promise.resolve();

    expect(sends).toEqual([['T1', 'A'], ['T1', 'A']]);
  });

  it('continues a cross-tentacle handoff when the old tentacle disconnects before its null ACK', async () => {
    const { controller, sends } = setup({ A: 'T1', B: 'T2' });
    controller.onSessionList('T1'); controller.onSessionList('T2');
    controller.setDesired('A'); await Promise.resolve(); controller.onAck(ack('T1', 'A'));

    controller.setDesired('B'); await Promise.resolve();
    expect(sends.at(-1)).toEqual(['T1', null]);
    controller.onTentacleAuthorityReset('T1');
    await Promise.resolve();

    expect(sends.at(-1)).toEqual(['T2', 'B']);
  });

  it('retains desired across a full Arm reconnect but requires a new barrier and ACK', async () => {
    const { controller, sends, disconnect } = setup();
    controller.onSessionList('T1'); controller.setDesired('A'); await Promise.resolve(); controller.onAck(ack('T1', 'A'));
    disconnect();
    expect(controller.desired).toBe('A');
    expect(controller.liveReady).toBe(false);
    controller.onSessionList('T1');
    expect(sends).toHaveLength(1); // disconnected host does not send
  });
});

describe('SessionSubscriptionController with the desktop local link', () => {
  function linkSetup() {
    let connected = true;
    const independent = new Set<string>(['T1']);
    const sends: Array<[string, string | null, string]> = [];
    const controller = new SessionSubscriptionController({
      isConnected: () => connected,
      resolveTentacle: (sessionId) => ({ A: 'T1', B: 'T1', D: 'T2' } as Record<string, string>)[sessionId],
      send: async (tentacleId, sessionId, requestId) => { sends.push([tentacleId, sessionId, requestId]); return true; },
      isRouteIndependent: (id) => independent.has(id),
      applySnapshot: vi.fn(),
      reportError: vi.fn(),
    });
    const withId = (m: SessionSubscriptionSetMessage, requestId: string) =>
      ({ ...m, payload: { ...m.payload, requestId } }) as SessionSubscriptionSetMessage;
    return { controller, sends, withId, setConnected: (v: boolean) => { connected = v; } };
  }

  it('keeps the linked Tentacle subscription across a Head disconnect', async () => {
    const { controller, sends, setConnected } = linkSetup();
    controller.setDesired('A'); controller.onSessionList('T1'); await Promise.resolve();
    controller.onAck(ack('T1', 'A'));
    setConnected(false); controller.onDisconnected();
    expect(controller.liveReady).toBe(true);
    setConnected(true); controller.resume(); await Promise.resolve();
    expect(sends.length).toBe(1);
  });

  it('can navigate on the linked Tentacle while the Head is down', async () => {
    const { controller, sends, setConnected } = linkSetup();
    controller.setDesired('A'); controller.onSessionList('T1'); await Promise.resolve();
    controller.onAck(ack('T1', 'A'));
    setConnected(false); controller.onDisconnected();
    controller.setDesired('B'); await Promise.resolve();
    expect(sends.at(-1)?.slice(0, 2)).toEqual(['T1', 'B']);
  });

  it('retains a linked obsolete flight through Head disconnect without reviving its live authority', () => {
    const { controller, sends, withId, setConnected } = linkSetup();
    controller.onSessionList('T1'); controller.setDesired('A'); controller.setDesired('B');
    setConnected(false); controller.onDisconnected();
    controller.onAck(withId(ack('T1', 'A'), sends[0][2]));
    expect(controller.confirmed).toBeNull();
    expect(controller.acceptsLive('A')).toBe(false);
    expect(controller.liveReady).toBe(false);
    expect(sends.map((send) => send.slice(0, 2))).toEqual([['T1', 'A'], ['T1', 'B']]);
    controller.onAck(withId(ack('T1', 'B'), sends[1][2]));
    expect(controller.liveReady).toBe(true);
    setConnected(true); controller.resume();
    expect(sends).toHaveLength(2);
  });

  it('a Head-routed Tentacle still resets and is not driven while the Head is down', async () => {
    const { controller, sends, setConnected } = linkSetup();
    controller.onSessionList('T2'); controller.setDesired('D'); await Promise.resolve();
    controller.onAck(ack('T2', 'D'));
    setConnected(false); controller.onDisconnected();
    expect(controller.liveReady).toBe(false);
    const n = sends.length;
    controller.resume(); await Promise.resolve();
    expect(sends.length).toBe(n);
  });

  it('ignores an ACK that echoes an earlier request id; accepts one without an id (older Tentacle)', async () => {
    const { controller, sends, withId } = linkSetup();
    controller.setDesired('A'); controller.onSessionList('T1'); await Promise.resolve();
    const first = sends.at(-1)![2];
    controller.onTentacleAuthorityReset('T1'); controller.onSessionList('T1'); await Promise.resolve();
    const second = sends.at(-1)![2];
    expect(second).not.toBe(first);
    controller.onAck(withId(ack('T1', 'A'), first));
    expect(controller.liveReady).toBe(false);
    controller.onAck(withId(ack('T1', 'A'), second));
    expect(controller.liveReady).toBe(true);
  });
});
