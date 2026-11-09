import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { InnerMessage } from '@kraki/protocol';
import { ChatView } from './ChatView';
import { useStore } from '../../hooks/useStore';
import { handleDataMessage } from '../../lib/message-router';
import { CommandState } from '../../lib/commands';
import type { ChatRow } from './Bubble';

// A live permission arrives through the real wire path (message-router →
// store card → ChatView) with no reload or session switch.

vi.mock('./ChatScroller', () => ({
  ChatScroller: ({ rows }: { rows: ChatRow[] }) => {
    const live = rows.find((r) => r.kind === 'live');
    return <div data-testid="live-action">{live?.kind === 'live' ? live.card.action?.type ?? 'none' : 'no-live-row'}</div>;
  },
}));
vi.mock('../../lib/message-db', () => ({
  putMessage: async () => {},
  putMessages: async () => {},
  deleteSessionMessages: async () => {},
  getMessagesInRange: async () => [],
}));
vi.mock('./Composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Composer')>();
  return {
    composerIntent: actual.composerIntent,
    Composer: ({ intent }: { intent: string }) => <div data-testid="composer-intent">{intent}</div>,
  };
});

const ctx = { cmdState: new CommandState() };
let seq = 0;
function wire(type: string, payload: Record<string, unknown>, spine = true): void {
  const msg = { type, sessionId: 's', deviceId: 'd', timestamp: '', ...(spine ? { seq: ++seq } : {}), payload } as unknown as InnerMessage;
  act(() => { handleDataMessage(msg, ctx); });
}
const permission = { type: 'permission', payload: { toolName: 'bash', args: { command: 'git push origin main' }, id: 'perm_1', description: 'Push to origin/main?' } };

beforeEach(() => {
  seq = 0;
  useStore.setState({
    sessions: new Map([['s', { id: 's', deviceId: 'd', state: 'active', lastSeq: 0, readSeq: 0 } as never]]),
    runtimeStatuses: new Map(), messages: new Map(), cards: new Map(), cardHoldUntil: new Map(), historyCaughtUpThrough: new Map(),
  });
});
afterEach(() => cleanup());

describe('ChatView live permission (real adapter wire sequence)', () => {
  it('shows the permission card and the deny composer as soon as card_action permission arrives', () => {
    render(<ChatView sessionId="s" topInset={40} />);
    wire('user_message', { content: 'Push the release branch' });
    // Prose before a tool is narration (TurnTracker): it streams as the draft,
    // is reconciled by a reset delta, and never becomes an agent_message.
    for (const chunk of ['I will push ', 'the release branch.']) wire('agent_message_delta', { content: chunk, reset: false }, false);
    wire('agent_message_delta', { content: 'I will push the release branch.', reset: true }, false);
    wire('card_action', { action: { type: 'tool_start', payload: { toolName: 'bash', headline: 'git push origin main', toolCallId: 't1' } } }, false);
    expect(screen.getByTestId('composer-intent')).toHaveTextContent('steer');

    wire('card_action', { action: permission }, false);

    expect(screen.getByTestId('live-action')).toHaveTextContent('permission');
    expect(screen.getByTestId('composer-intent')).toHaveTextContent('denyPermission');
  });

  it('a permission after tool output (no narration) still shows live', () => {
    render(<ChatView sessionId="s" topInset={40} />);
    wire('user_message', { content: 'Push it' });
    wire('card_action', { action: { type: 'tool_complete', payload: { toolName: 'bash', headline: 'pnpm -r test', toolCallId: 't0' } } }, false);
    wire('card_action', { action: permission }, false);
    expect(screen.getByTestId('live-action')).toHaveTextContent('permission');
    expect(screen.getByTestId('composer-intent')).toHaveTextContent('denyPermission');
  });

  it('a concluding agent_message closes the turn: a later card_action is a late frame (MessageStore closedCardTurns parity)', () => {
    // The scripted demo's order (reply, then a permission in the same turn).
    // Real adapters only emit a non-question agent_message when the turn
    // finishes, immediately followed by idle, so this never happens live.
    render(<ChatView sessionId="s" topInset={40} />);
    wire('user_message', { content: 'Push it' });
    wire('agent_message', { content: 'Here is what I found.' });
    wire('card_action', { action: permission }, false);
    expect(screen.getByTestId('live-action')).toHaveTextContent('no-live-row');
    expect(screen.getByTestId('composer-intent')).toHaveTextContent('steer');
  });
});
