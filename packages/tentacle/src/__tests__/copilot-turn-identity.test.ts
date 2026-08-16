import { describe, expect, it, vi } from 'vitest';
import { CopilotAdapter } from '../adapters/copilot.js';

describe('Copilot relay turn identity', () => {
  it('echoes the accepted turn on terminal callbacks and reports settlement', () => {
    const adapter = new CopilotAdapter();
    const entry = {
      session: {},
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      relayTurnId: undefined as string | undefined,
      turnSettled: false,
    };
    (adapter as unknown as { sessions: Map<string, typeof entry> }).sessions.set('s1', entry);
    const onMessage = vi.fn();
    const onIdle = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;
    adapter.setTurnIdentity('s1', 's1:copilot-turn');

    (adapter as unknown as { emitMessage: (sessionId: string, content: string) => void })
      .emitMessage('s1', 'done');
    (adapter as unknown as { emitIdle: (sessionId: string) => void })
      .emitIdle('s1');

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'done', turnId: 's1:copilot-turn' });
    expect(onIdle).toHaveBeenCalledWith('s1', { turnId: 's1:copilot-turn' });
    expect(adapter.isTurnSettled('s1')).toBe(true);
  });
});
