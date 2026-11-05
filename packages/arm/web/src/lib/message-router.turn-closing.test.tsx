/**
 * K-098: at turn end the idle arrives before the closing session_list that
 * carries the reply as the row preview. The sidebar row must not flash the
 * user's prompt with the human glyph in between.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./message-db', () => ({
  putMessage: async () => {},
  putMessages: async () => {},
  getMessages: async () => [],
  getAllMessages: async () => new Map(),
  getLastSeq: async () => 0,
  getMessagesInRange: async () => [],
  deleteSessionMessages: async () => {},
  updateSessionMessages: async () => {},
  clearAllMessages: async () => {},
}));

import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useStore } from '../hooks/useStore';
import { CommandState } from './commands';
import { messageProvider } from './message-provider';
import { handleDataMessage, TURN_CLOSING_MAX_MS } from './message-router';
import { SessionRow } from '../components/sessions/SessionRow';
import type { InnerMessage } from '@kraki/protocol';

const route = (msg: Record<string, unknown>) => handleDataMessage({
  deviceId: 'dev-t', timestamp: new Date().toISOString(), sessionId: 's1', ...msg,
} as unknown as InnerMessage, { cmdState: new CommandState(), messageProvider } as never);

function Row() {
  const session = useStore((s) => s.sessions.get('s1'))!;
  return <MemoryRouter><SessionRow session={session} selected={false} pinned={false} narrow={false} /></MemoryRouter>;
}

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
  vi.spyOn(messageProvider, 'reconcileTail').mockImplementation(() => {});
  useStore.getState().setDevices([{ id: 'dev-t', name: 'Mac', role: 'tentacle', online: true }]);
  useStore.getState().upsertSession({ id: 's1', deviceId: 'dev-t', deviceName: 'Mac', agent: 'pi', state: 'active', messageCount: 1 });
  useStore.getState().setSessionPreview('s1', { text: 'Fix the test', type: 'user', timestamp: new Date().toISOString() }, false);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('turn end sidebar row (K-098)', () => {
  it('keeps the row working from idle until the closing digest', () => {
    render(<Row />);
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    act(() => route({ type: 'idle', seq: 5, payload: {} }));
    // Chat state is idle at once (Stop -> Send) …
    expect(useStore.getState().sessions.get('s1')?.state).toBe('idle');
    // … but the row does not show the prompt as "Last message from you".
    expect(screen.queryByLabelText('Last message from you')).toBeNull();
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    // The closing digest brings the reply.
    act(() => {
      useStore.getState().setSessionPreview('s1', { text: 'Done', type: 'agent', timestamp: new Date().toISOString() }, false);
      useStore.getState().setTurnClosing('s1', false);
    });
    expect(screen.getByLabelText('Last message from agent')).toBeInTheDocument();
  });

  it('gives up waiting when no digest arrives', () => {
    vi.useFakeTimers();
    route({ type: 'idle', seq: 5, payload: {} });
    expect(useStore.getState().closingTurns.has('s1')).toBe(true);
    vi.advanceTimersByTime(TURN_CLOSING_MAX_MS);
    expect(useStore.getState().closingTurns.has('s1')).toBe(false);
  });

  it('a synthetic idle for an already idle session does not show working', () => {
    useStore.getState().upsertSession({ ...useStore.getState().sessions.get('s1')!, state: 'idle' });
    route({ type: 'idle', seq: 1, payload: {} });
    expect(useStore.getState().closingTurns.has('s1')).toBe(false);
  });
});
