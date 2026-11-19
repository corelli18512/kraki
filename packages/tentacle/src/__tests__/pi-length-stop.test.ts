/**
 * A Pi run whose model output was cut off at the output-token limit
 * (`stopReason: 'length'`) must end as a FAILED turn with a clear reason, not
 * as a silent reply-less idle. Replays the two real event sequences from
 * incident mwma0qqh (2026-11-18): truncation + overflow compaction failing
 * with 401, and truncation + a compact-and-retry that truncated again.
 */

import { describe, it, expect, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';
import { handleEvent } from '../adapters/pi-events.js';
import { turnFixture } from './helpers/turn-fixture.js';

function makeAdapter() {
  const adapter = new PiAdapter({ cliPath: '/bin/true' });
  const sid = 's1';
  const session = {
    proc: { alive: true, send: vi.fn(), sendRaw: vi.fn(), request: vi.fn().mockResolvedValue({}), kill: vi.fn() },
    cwd: '/tmp',
    model: 'anthropic/claude-opus-5-5',
    mode: 'auto',
    usage: {},
    lastActivity: Date.now(),
    turn: turnFixture(adapter, sid, { open: true }),
    exitObserved: false,
    pendingPerms: new Map<string, string>(),
    pendingQuestions: new Map<string, string>(),
    lastStopReason: undefined as string | undefined,
    pendingMaintenanceIdle: false,
    aborting: false,
  };
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set(sid, session);
  const onError = vi.fn();
  const onMessage = vi.fn();
  const onIdle = vi.fn();
  adapter.onError = onError;
  adapter.onMessage = onMessage;
  adapter.onIdle = onIdle;
  const emit = (e: Record<string, unknown>) => handleEvent(adapter, sid, e);
  return { adapter, session, emit, onError, onMessage, onIdle };
}

const truncated = (output = 42666, text?: string) => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '' }, ...(text ? [{ type: 'text', text }] : [])],
    stopReason: 'length',
    usage: { output },
  },
});

describe('pi length (output-limit) stop', () => {
  it('truncation then failed overflow compaction (401) ends as a failed turn naming both causes', () => {
    const { emit, onError, onMessage, onIdle } = makeAdapter();
    emit(truncated());
    emit({ type: 'agent_end', willRetry: false });
    emit({ type: 'compaction_start', reason: 'overflow' });
    emit({
      type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false,
      errorMessage: 'Context overflow recovery failed: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
    });
    expect(onError).not.toHaveBeenCalled();
    emit({ type: 'agent_settled' });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const message = onError.mock.calls[0][1].message as string;
    expect(message).toMatch(/output limit/i);
    expect(message).toContain('42666');
    expect(message).toMatch(/revoked/);
    expect(message).not.toMatch(/Context overflow recovery failed/);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('truncation, compact-and-retry, truncation again ends as a failed turn', () => {
    const { emit, onError, onIdle } = makeAdapter();
    emit(truncated());
    emit({ type: 'agent_end', willRetry: false });
    emit({ type: 'compaction_start', reason: 'overflow' });
    emit({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true });
    emit({ type: 'agent_start' });
    emit(truncated());
    emit({ type: 'agent_end', willRetry: false });
    emit({
      type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false,
      errorMessage: 'Truncated response recovery failed after one compact-and-retry attempt.',
    });
    emit({ type: 'agent_settled' });

    expect(onError).toHaveBeenCalledTimes(1);
    const message = onError.mock.calls[0][1].message as string;
    expect(message).toMatch(/output limit/i);
    expect(message).toMatch(/compact-and-retry/);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('a successful retry after truncation clears the provisional failure', () => {
    const { emit, onError, onMessage } = makeAdapter();
    emit(truncated());
    emit({ type: 'compaction_start', reason: 'overflow' });
    emit({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true });
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } });
    emit({ type: 'agent_settled' });

    expect(onError).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'done' });
  });

  it('a compaction failure after a completed reply does not fail the turn', () => {
    const { emit, onError, onMessage } = makeAdapter();
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'all good' }], stopReason: 'stop' } });
    emit({ type: 'agent_end', willRetry: false });
    emit({ type: 'compaction_start', reason: 'threshold' });
    emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, errorMessage: 'Auto-compaction failed: 500' });
    emit({ type: 'agent_settled' });

    expect(onError).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'all good' });
  });

  it('a failed threshold compaction after truncation is not reported as a retry failure', () => {
    const { emit, onError } = makeAdapter();
    emit(truncated(128000));
    emit({ type: 'agent_end', willRetry: false });
    emit({ type: 'compaction_start', reason: 'threshold' });
    emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, errorMessage: 'Auto-compaction failed: 500' });
    emit({ type: 'agent_settled' });

    expect(onError).toHaveBeenCalledTimes(1);
    const message = onError.mock.calls[0][1].message as string;
    expect(message).toMatch(/output limit/i);
    expect(message).not.toMatch(/Automatic retry failed|Auto-compaction/);
  });
});
