import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { SessionPage } from './SessionPage';
import { useStore } from '../hooks/useStore';
import { diag } from '../lib/diag';
import { StabilityTracker, type OpenSummary } from '../lib/diag/stability';
import type { ChatMessage } from '../types/store';

vi.mock('../hooks/useNarrow', () => ({ useNarrow: () => false }));
vi.mock('../lib/ws-client', () => ({ wsClient: { setSessionMode: vi.fn(), markRead: vi.fn() } }));
vi.mock('../lib/message-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/message-provider')>();
  actual.messageProvider.ensureLoaded = vi.fn();
  return actual;
});
vi.mock('../lib/message-db', () => ({
  putMessage: async () => {}, putMessages: async () => {}, deleteSessionMessages: async () => {}, getMessagesInRange: async () => [],
}));
vi.mock('../components/chat/ChatScroller', () => ({ ChatScroller: () => null }));
vi.mock('../components/chat/Composer', () => ({ composerIntent: () => 'steer', Composer: () => null }));
vi.mock('../components/devices/SessionInfoPanel', () => ({ SessionInfoPanel: () => null }));

const opens: OpenSummary[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  opens.length = 0;
  diag.stability.reset();
  diag.stability.onOpen = (o) => opens.push(o);
  useStore.getState().reset();
  useStore.getState().setSessions([
    { id: 's1', deviceId: 'd1', agent: 'pi', state: 'idle', title: 'Cached', messageCount: 2, lastSeq: 2 },
  ]);
  useStore.getState().setDevices([{ id: 'd1', name: 'PC', role: 'tentacle', online: true }]);
  useStore.getState().setStatus('connected');
});
afterEach(() => {
  cleanup();
  diag.stability.onOpen = undefined;
  diag.stability.reset();
  vi.useRealTimers();
});

const message = (seq: number) => ({ type: 'agent_message', seq, sessionId: 's1', deviceId: 'd1', timestamp: '', payload: { content: `m${seq}` } }) as ChatMessage;

it('an opened conversation that is already current on screen is recorded as current at once (Mac MainWindowView)', () => {
  useStore.setState({ messages: new Map([['s1', [message(1), message(2)]]]) });
  render(<MemoryRouter initialEntries={['/session/s1']}><Routes><Route path="/session/:sessionId" element={<SessionPage />} /></Routes></MemoryRouter>);
  act(() => { vi.advanceTimersByTime(StabilityTracker.readyTimeout + 1_000); });
  expect(opens).toEqual([expect.objectContaining({ outcome: 'current', gap: 0, firstContentMs: expect.any(Number), currentMs: expect.any(Number) })]);
});

it('an opened conversation behind the Tentacle stays open until its messages arrive', () => {
  useStore.setState({ messages: new Map([['s1', [message(1)]]]) });
  render(<MemoryRouter initialEntries={['/session/s1']}><Routes><Route path="/session/:sessionId" element={<SessionPage />} /></Routes></MemoryRouter>);
  expect(opens).toEqual([]);
  act(() => { useStore.setState({ messages: new Map([['s1', [message(1), message(2)]]]) }); });
  expect(opens).toEqual([expect.objectContaining({ outcome: 'current', gap: 1 })]);
});
