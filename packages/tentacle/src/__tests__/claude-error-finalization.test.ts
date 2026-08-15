import { describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter, normalizeClaudeSDKError } from '../adapters/claude.js';

type Entry = {
  query: object | null;
  inputChannel: { push: ReturnType<typeof vi.fn> };
  pendingPermissions: Map<string, unknown>;
  pendingQuestions: Map<string, unknown>;
  pendingText?: string;
  pendingError?: { message: string; quality: number };
  turnFinalized?: boolean;
};

function setup() {
  const adapter = new ClaudeAdapter();
  const entry: Entry = {
    query: {},
    inputChannel: { push: vi.fn() },
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingText: '',
    turnFinalized: false,
  };
  (adapter as unknown as { sessions: Map<string, Entry> }).sessions.set('s1', entry);
  const handle = (msg: Record<string, unknown>) =>
    (adapter as unknown as { handleSDKMessage: (sessionId: string, msg: Record<string, unknown>) => void })
      .handleSDKMessage('s1', msg);
  return { adapter, entry, handle };
}

describe('Claude error finalization', () => {
  it('extracts the concrete synthetic assistant API error instead of unknown', () => {
    const normalized = normalizeClaudeSDKError({
      error: 'unknown',
      apiErrorStatus: 400,
      message: {
        content: [{ type: 'text', text: 'API Error: 400 Your input exceeds the context window of this model. (request id: req_123)' }],
      },
    });

    expect(normalized.message).toContain('Your input exceeds the context window');
    expect(normalized.message).not.toBe('Claude API error: unknown');
    expect(normalized.status).toBe(400);
  });

  it('does not use result subtype success as an error message', () => {
    const normalized = normalizeClaudeSDKError({ is_error: true, subtype: 'success', api_error_status: 400 });
    expect(normalized.message).toBe('Claude API error (HTTP 400)');
  });

  it('emits one concrete terminal error and one idle for assistant error plus result', () => {
    const { adapter, handle } = setup();
    const onError = vi.fn();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;

    handle({
      type: 'assistant',
      error: 'unknown',
      apiErrorStatus: 400,
      message: { content: [{ type: 'text', text: 'API Error: 400 Your input exceeds the context window.' }] },
    });
    expect(onError).not.toHaveBeenCalled();

    handle({ type: 'result', is_error: true, subtype: 'success', api_error_status: 400, errors: [] });
    handle({ type: 'result', is_error: true, subtype: 'success', api_error_status: 400, errors: [] });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1].message).toContain('Your input exceeds the context window');
    expect(onError.mock.calls[0]?.[1].message).not.toBe('success');
    expect(onMessage).not.toHaveBeenCalled();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('clears a stale pending error when the authoritative result succeeds', () => {
    const { adapter, entry, handle } = setup();
    const onError = vi.fn();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;

    entry.pendingText = 'recovered answer';
    handle({ type: 'assistant', error: 'unknown', message: { content: [] } });
    handle({ type: 'result', is_error: false, subtype: 'success' });

    expect(onError).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'recovered answer' });
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(entry.pendingError).toBeUndefined();
  });

  it('re-arms the result boundary when a steer follows a completed turn', async () => {
    const { adapter, entry } = setup();
    entry.turnFinalized = true;

    await adapter.sendMessage('s1', 'new prompt', undefined, { delivery: 'steer' });

    expect(entry.turnFinalized).toBe(false);
    expect(entry.inputChannel.push).toHaveBeenCalledWith({
      type: 'user',
      message: { role: 'user', content: 'new prompt' },
      parent_tool_use_id: null,
    });
  });
});
