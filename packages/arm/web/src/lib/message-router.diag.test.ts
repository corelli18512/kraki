import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InnerMessage } from '@kraki/protocol';
vi.mock('./message-db', () => ({
  putMessage: async () => {}, putMessages: async () => {}, getMessages: async () => [],
  getLastSeq: async () => 0, deleteSessionMessages: async () => {}, clearAllMessages: async () => {},
}));
import { useStore } from '../hooks/useStore';
import { CommandState } from './commands';
import { outbox } from './chat/outbox';
import { diag } from './diag';
import { handleDataMessage } from './message-router';
import { messageProvider } from './message-provider';

let now = 0, seq = 0;
const summary = vi.fn();
function receive(type: string, payload: Record<string, unknown>, sessionId = 's') {
  handleDataMessage({ type, payload, sessionId, deviceId: 'tentacle', seq: ++seq, timestamp: new Date().toISOString() } as InnerMessage,
    { cmdState: new CommandState() });
}
function echo(opts: { answerTo?: string; delivery?: 'steer' } = {}) {
  const clientId = outbox.send('s', 'private prompt', opts);
  receive('user_message', { clientId, content: 'private prompt', ...opts });
  return clientId;
}

beforeEach(() => {
  outbox.reset(); useStore.getState().reset(); messageProvider.clear();
  useStore.getState().upsertSession({ id: 's', deviceId: 'tentacle', deviceName: 'Test', agent: 'pi', state: 'active', messageCount: 0 });
  outbox.configure({ send: async () => true, isDeliveryPathUp: () => true });
  diag.replies.backgrounded(); diag.replies.onSummary = summary;
  diag.replies.now = () => now;
  summary.mockClear(); now = seq = 0;
});
afterEach(() => { diag.replies.onSummary = undefined; diag.replies.backgrounded(); vi.restoreAllMocks(); });

describe('reply.summary live router hooks', () => {
  it('starts before the own echo clears the outbox, then measures card/text/idle exactly once', () => {
    echo({ answerTo: 'q1' });
    expect(outbox.forSession('s')).toEqual([]);
    now = 100; receive('card_action', { action: null });
    receive('agent_message_delta', { content: '', reset: true });
    now = 200; receive('card_action', { action: { type: 'tool_start', payload: { toolName: 'private tool' } } });
    now = 500; receive('agent_message_delta', { content: 'private delta', reset: true });
    now = 3500; receive('agent_message_delta', { content: 'more' });
    now = 4000; receive('agent_message', { content: 'private message' });
    now = 4500; receive('idle', {}); receive('idle', {});
    expect(summary).toHaveBeenCalledExactlyOnceWith({ kind: 'answer', outcome: 'completed', durationMs: 4500,
      firstActivityMs: 200, firstTextMs: 500, deltas: 2, maxGapMs: 3000, stalls: 1 });
    expect(JSON.stringify(summary.mock.calls)).not.toContain('private');
  });
  it('does not start turns for other devices, steers, hidden echoes or a duplicate own echo', () => {
    receive('user_message', { clientId: 'other', content: 'other' }); receive('idle', {});
    echo({ delivery: 'steer' }); receive('idle', {});
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    echo(); receive('idle', {}); hidden.mockRestore();
    expect(summary).not.toHaveBeenCalled();
    const clientId = echo();
    receive('user_message', { clientId, content: 'private prompt' }); receive('idle', {});
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'typed', outcome: 'completed' }));
  });
  it.each([
    ['idle', { reason: 'failed' }, 'failed'], ['idle', { reason: 'aborted' }, 'stopped'],
    ['turn_status', { action: { type: 'failed' } }, 'failed'], ['turn_status', {}, 'stopped'],
    ['interrupted_turn', { reason: 'process_lost' }, 'stopped'], ['session_ended', {}, 'stopped'], ['session_deleted', {}, 'stopped'],
  ] as const)('%s closes with native outcome %s', (type, payload, outcome) => {
    echo(); receive(type, payload);
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome }));
  });
  it('range/history batches never start a reply or count old text as live progress', () => {
    echo();
    messageProvider.handleRangeBatch('s', [
      { type: 'agent_message', sessionId: 's', seq: 20, payload: { content: 'history' } },
      { type: 'idle', sessionId: 's', seq: 21, payload: {} },
    ], 20, 21, false);
    expect(summary).not.toHaveBeenCalled();
    now = 500; receive('idle', {});
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ durationMs: 500, deltas: 0 }));
    expect(summary.mock.calls[0][0].firstTextMs).toBeUndefined();
  });
});
