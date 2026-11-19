import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { useStore } from '../hooks/useStore';
import { CommandState } from './commands';
import { messageProvider } from './message-provider';
import { handleDataMessage } from './message-router';
import type { InnerMessage } from '@kraki/protocol';

beforeEach(() => {
  useStore.getState().reset();
  useStore.getState().setDevices([{ id: 'dev-t', name: 'Mac', role: 'tentacle', online: true }]);
});

function greet(payload: Record<string, unknown>) {
  handleDataMessage({ type: 'device_greeting', deviceId: 'dev-t', seq: 0, timestamp: '', payload } as unknown as InnerMessage,
    { cmdState: new CommandState(), messageProvider } as never);
}

// K-097: a Tentacle with no coding agent leaves `agents` out of its greeting.
// The greeting itself is the answer: "no agents", not "still connecting".
describe('device_greeting agents (K-097)', () => {
  it('stores a greeting without agents as an empty list', () => {
    greet({ name: 'Mac', version: '0.41.0' });
    expect(useStore.getState().deviceAgents.get('dev-t')).toEqual([]);
  });

  it('a later greeting without agents replaces the agents the computer had', () => {
    greet({ name: 'Mac', agents: [{ type: 'code', id: 'pi', models: ['m'] }] });
    expect(useStore.getState().deviceAgents.get('dev-t')).toHaveLength(1);
    greet({ name: 'Mac', agents: [] });
    expect(useStore.getState().deviceAgents.get('dev-t')).toEqual([]);
  });
});
