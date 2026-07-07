import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../hooks/useStore';
import * as commands from './commands';
import { handleDataMessage } from './message-router';
import type { InnerMessage } from '@kraki/protocol';

beforeEach(() => {
  useStore.getState().reset();
});

describe('setSessionMode', () => {
  it('sends set_session_mode message', () => {
    const send = vi.fn();
    commands.setSessionMode('sess-1', 'execute', send);
    expect(send).toHaveBeenCalledWith({
      type: 'set_session_mode',
      sessionId: 'sess-1',
      payload: { mode: 'execute' },
    });
  });

  it('updates store session mode', () => {
    const send = vi.fn();
    commands.setSessionMode('sess-1', 'execute', send);
    expect(useStore.getState().sessionModes.get('sess-1')).toBe('execute');
  });

});

describe('handleDataMessage session_mode_set', () => {
  const cmdState = new commands.CommandState();

  const makeModeSetMsg = (sessionId: string, mode: string) => ({
    type: 'session_mode_set' as const,
    deviceId: 'dev-tentacle',
    seq: 10,
    timestamp: new Date().toISOString(),
    sessionId,
    payload: { mode },
  });

  const seedSession = (id: string) => {
    useStore.getState().upsertSession({
      id, deviceId: 'dev-tentacle', deviceName: 'test', agent: 'test', state: 'active', messageCount: 0,
    });
  };

  it('restores auto mode from replayed message', () => {
    seedSession('sess-1');
    handleDataMessage(makeModeSetMsg('sess-1', 'execute') as InnerMessage, {
      cmdState,
    });
    expect(useStore.getState().sessionModes.get('sess-1')).toBe('execute');
  });

  it('restores discuss mode (clears entry)', () => {
    seedSession('sess-1');
    useStore.getState().setSessionMode('sess-1', 'execute');
    handleDataMessage(makeModeSetMsg('sess-1', 'discuss') as InnerMessage, {
      cmdState,
    });
    expect(useStore.getState().sessionModes.has('sess-1')).toBe(false);
  });

  it('works for live (non-replay) messages', () => {
    seedSession('sess-2');
    handleDataMessage(makeModeSetMsg('sess-2', 'execute') as InnerMessage, {
      cmdState,
    });
    expect(useStore.getState().sessionModes.get('sess-2')).toBe('execute');
  });
});

describe('sendInput', () => {
  const seedSession = (id: string) => {
    useStore.getState().upsertSession({
      id, deviceId: 'dev-t', deviceName: 't', agent: 'test', state: 'active', messageCount: 0,
    });
  };

  it('inserts pending_input with a generated clientId and sends it in payload', () => {
    const send = vi.fn();
    commands.sendInput('sess-1', 'hello world', send);

    const msgs = useStore.getState().messages.get('sess-1');
    expect(msgs).toHaveLength(1);
    const pending = msgs![0] as { type: string; clientId: string; id: string; text: string };
    expect(pending.type).toBe('pending_input');
    expect(typeof pending.clientId).toBe('string');
    expect(pending.clientId.length).toBeGreaterThan(0);
    // id and clientId mirror each other (chosen for clarity)
    expect(pending.id).toBe(pending.clientId);
    expect(pending.text).toBe('hello world');

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0] as {
      type: string;
      sessionId: string;
      payload: { text: string; clientId: string; attachments?: unknown };
    };
    expect(sent.type).toBe('send_input');
    expect(sent.sessionId).toBe('sess-1');
    expect(sent.payload.text).toBe('hello world');
    expect(sent.payload.clientId).toBe(pending.clientId);
  });

  it('generates distinct clientIds on consecutive sends (no collision)', () => {
    const send = vi.fn();
    commands.sendInput('sess-1', 'first', send);
    commands.sendInput('sess-1', 'second', send);

    const msgs = useStore.getState().messages.get('sess-1');
    expect(msgs).toHaveLength(2);
    const a = msgs![0] as { clientId: string };
    const b = msgs![1] as { clientId: string };
    expect(a.clientId).not.toBe(b.clientId);

    const sent1 = send.mock.calls[0][0] as { payload: { clientId: string } };
    const sent2 = send.mock.calls[1][0] as { payload: { clientId: string } };
    expect(sent1.payload.clientId).toBe(a.clientId);
    expect(sent2.payload.clientId).toBe(b.clientId);
  });

  it('round-trip: rapid send → tentacle echoes both acks → both pendings resolved with correct content', () => {
    seedSession('sess-1');
    // Two rapid sends produce two pending_inputs with distinct clientIds.
    const send = vi.fn();
    commands.sendInput('sess-1', 'first message', send);
    commands.sendInput('sess-1', 'second message', send);

    const sent1 = send.mock.calls[0][0] as { payload: { clientId: string } };
    const sent2 = send.mock.calls[1][0] as { payload: { clientId: string } };
    const cidA = sent1.payload.clientId;
    const cidB = sent2.payload.clientId;

    // Tentacle echoes back user_message broadcasts with the corresponding clientId.
    // (We feed these through the router exactly as the live WS path would.)
    const cmdState = new commands.CommandState();
    const sendEncrypted = vi.fn();

    handleDataMessage(
      {
        type: 'user_message',
        sessionId: 'sess-1',
        deviceId: 'dev-tentacle',
        seq: 1,
        timestamp: new Date().toISOString(),
        payload: { content: 'first message', clientId: cidA },
      } as InnerMessage,
      { replayingSessions: new Set(), cmdState, sendEncrypted },
    );
    handleDataMessage(
      {
        type: 'user_message',
        sessionId: 'sess-1',
        deviceId: 'dev-tentacle',
        seq: 2,
        timestamp: new Date().toISOString(),
        payload: { content: 'second message', clientId: cidB },
      } as InnerMessage,
      { replayingSessions: new Set(), cmdState, sendEncrypted },
    );

    const msgs = useStore.getState().messages.get('sess-1')!;
    expect(msgs).toHaveLength(2);
    // Both pendings became user_messages, with correct content attributed
    // to their original send (no cross-attribution).
    expect(msgs.every((m) => m.type === 'user_message')).toBe(true);
    expect((msgs[0] as { seq: number }).seq).toBe(1);
    expect((msgs[0] as { payload: { content: string } }).payload.content).toBe('first message');
    expect((msgs[1] as { seq: number }).seq).toBe(2);
    expect((msgs[1] as { payload: { content: string } }).payload.content).toBe('second message');
  });

  it('round-trip: out-of-order acks still attribute content correctly', () => {
    seedSession('sess-1');
    const send = vi.fn();
    commands.sendInput('sess-1', 'first', send);
    commands.sendInput('sess-1', 'second', send);

    const cidA = (send.mock.calls[0][0] as { payload: { clientId: string } }).payload.clientId;
    const cidB = (send.mock.calls[1][0] as { payload: { clientId: string } }).payload.clientId;

    const cmdState = new commands.CommandState();
    const sendEncrypted = vi.fn();

    // Ack for second send arrives first
    handleDataMessage(
      {
        type: 'user_message',
        sessionId: 'sess-1',
        deviceId: 'dev-t',
        seq: 2,
        timestamp: new Date().toISOString(),
        payload: { content: 'second', clientId: cidB },
      } as InnerMessage,
      { replayingSessions: new Set(), cmdState, sendEncrypted },
    );
    // Then ack for first send
    handleDataMessage(
      {
        type: 'user_message',
        sessionId: 'sess-1',
        deviceId: 'dev-t',
        seq: 1,
        timestamp: new Date().toISOString(),
        payload: { content: 'first', clientId: cidA },
      } as InnerMessage,
      { replayingSessions: new Set(), cmdState, sendEncrypted },
    );

    const msgs = useStore.getState().messages.get('sess-1')!;
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as { seq: number }).seq).toBe(1);
    expect((msgs[0] as { payload: { content: string } }).payload.content).toBe('first');
    expect((msgs[1] as { seq: number }).seq).toBe(2);
    expect((msgs[1] as { payload: { content: string } }).payload.content).toBe('second');
  });

  it('round-trip: user_message from another device (no clientId, different content) appends instead of stealing our pending', () => {
    seedSession('sess-1');
    const send = vi.fn();
    commands.sendInput('sess-1', 'mine', send);
    const cidA = (send.mock.calls[0][0] as { payload: { clientId: string } }).payload.clientId;

    const cmdState = new commands.CommandState();
    const sendEncrypted = vi.fn();

    // Another device sends a message (no clientId on the broadcast).
    // Content does not match our pending text → must NOT resolve our
    // pending. Append instead, pending stays in-flight.
    handleDataMessage(
      {
        type: 'user_message',
        sessionId: 'sess-1',
        deviceId: 'dev-other',
        seq: 1,
        timestamp: new Date().toISOString(),
        payload: { content: 'from someone else' },
      } as InnerMessage,
      { replayingSessions: new Set(), cmdState, sendEncrypted },
    );

    let msgs = useStore.getState().messages.get('sess-1')!;
    expect(msgs).toHaveLength(2);
    // Pending still in-flight, other device's message appended.
    const pendings = msgs.filter((m) => m.type === 'pending_input');
    const others = msgs.filter((m) => m.type === 'user_message');
    expect(pendings).toHaveLength(1);
    expect((pendings[0] as { clientId: string }).clientId).toBe(cidA);
    expect(others).toHaveLength(1);
    expect((others[0] as { payload: { content: string } }).payload.content).toBe('from someone else');

    // Our own ack arrives with clientId → resolves our pending cleanly.
    handleDataMessage(
      {
        type: 'user_message',
        sessionId: 'sess-1',
        deviceId: 'dev-t',
        seq: 2,
        timestamp: new Date().toISOString(),
        payload: { content: 'mine', clientId: cidA },
      } as InnerMessage,
      { replayingSessions: new Set(), cmdState, sendEncrypted },
    );

    msgs = useStore.getState().messages.get('sess-1')!;
    const userMessages = msgs.filter((m) => m.type === 'user_message');
    expect(userMessages).toHaveLength(2);
    // Sorted by seq: other device's seq=1 first, ours seq=2 second.
    expect((userMessages[0] as { payload: { content: string } }).payload.content).toBe('from someone else');
    expect((userMessages[1] as { payload: { content: string } }).payload.content).toBe('mine');
    expect(msgs.filter((m) => m.type === 'pending_input')).toHaveLength(0);
  });

  it('back-compat: new client + old tentacle (clientId stripped, content preserved) still resolves our pending', () => {
    seedSession('sess-1');
    const send = vi.fn();
    commands.sendInput('sess-1', 'hello', send);

    const cmdState = new commands.CommandState();
    const sendEncrypted = vi.fn();

    // Simulate an old tentacle: relayed user_message has no clientId,
    // but the content matches our pending's text.
    handleDataMessage(
      {
        type: 'user_message',
        sessionId: 'sess-1',
        deviceId: 'dev-t',
        seq: 1,
        timestamp: new Date().toISOString(),
        payload: { content: 'hello' },
      } as InnerMessage,
      { replayingSessions: new Set(), cmdState, sendEncrypted },
    );

    const msgs = useStore.getState().messages.get('sess-1')!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('user_message');
    expect((msgs[0] as { seq: number }).seq).toBe(1);
    expect((msgs[0] as { payload: { content: string } }).payload.content).toBe('hello');
  });

  it('round-trip: duplicate user_message broadcast (relay re-send) does not create a duplicate bubble', () => {
    seedSession('sess-1');
    const send = vi.fn();
    commands.sendInput('sess-1', 'hello', send);
    const cidA = (send.mock.calls[0][0] as { payload: { clientId: string } }).payload.clientId;

    const cmdState = new commands.CommandState();
    const sendEncrypted = vi.fn();

    const ack = {
      type: 'user_message',
      sessionId: 'sess-1',
      deviceId: 'dev-t',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { content: 'hello', clientId: cidA },
    } as InnerMessage;

    handleDataMessage(ack, { replayingSessions: new Set(), cmdState, sendEncrypted });
    // Relay re-broadcasts the same message
    handleDataMessage(ack, { replayingSessions: new Set(), cmdState, sendEncrypted });

    const msgs = useStore.getState().messages.get('sess-1')!;
    // One resolved user_message — second broadcast must not duplicate.
    // (First broadcast resolved the pending; second has no pending
    // matching the clientId, falls through to appendMessage, which
    // dedups by [type, seq].)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('user_message');
    expect((msgs[0] as { seq: number }).seq).toBe(1);
  });
});
