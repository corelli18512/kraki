import { describe, expect, it, vi } from 'vitest';
import { MultiAgentAdapter } from '../adapters/multi.js';
import type { AgentAdapter } from '../adapters/base.js';

/**
 * Regression guard: wireCallbacks must forward EVERY on* callback from a
 * sub-adapter up to the MultiAgentAdapter. onNarration was silently missing,
 * which dropped the finalized-narration TRACE step (agent_narration never
 * reached relay-client → trace.jsonl), even though pi.ts fired it correctly.
 */
describe('MultiAgentAdapter.wireCallbacks forwards sub-adapter callbacks', () => {
  function makeStubAdapter(): AgentAdapter {
    // Bare stub: wireCallbacks only assigns to these on* fields; we then
    // invoke them to prove the multi-adapter's matching callback fires.
    return {
      onSessionCreated: null,
      onMessage: null,
      onMessageDelta: null,
      onFinalizeDelta: null,
      onNarration: null,
      onNarrationTrace: null,
      onPermissionRequest: null,
      onPermissionAutoResolved: null,
      onQuestionAutoResolved: null,
      onQuestionRequest: null,
      onToolStart: null,
      onToolComplete: null,
      onAttachmentBytes: null,
      onIdle: null,
      onFlushComplete: null,
      onError: null,
      onSessionEnded: null,
      onSessionEvicted: null,
      onTitleChanged: null,
      onUsageUpdate: null,
    } as unknown as AgentAdapter;
  }

  it('forwards onNarration', () => {
    const multi = new MultiAgentAdapter({ agentIds: ['pi'] });
    const stub = makeStubAdapter();
    (multi as unknown as { wireCallbacks(id: string, a: AgentAdapter): void }).wireCallbacks('pi', stub);

    const seen = vi.fn();
    multi.onNarration = seen;
    stub.onNarration?.('s1', { content: 'thinking out loud' });

    expect(seen).toHaveBeenCalledWith('s1', { content: 'thinking out loud' });
  });

  it('forwards onNarrationTrace (TRACE axis — regression guard, same class as onNarration)', () => {
    const multi = new MultiAgentAdapter({ agentIds: ['pi'] });
    const stub = makeStubAdapter();
    (multi as unknown as { wireCallbacks(id: string, a: AgentAdapter): void }).wireCallbacks('pi', stub);

    const seen = vi.fn();
    multi.onNarrationTrace = seen;
    stub.onNarrationTrace?.('s1', { content: 'a traced step' });

    expect(seen).toHaveBeenCalledWith('s1', { content: 'a traced step' });
  });

  it('forwards onFinalizeDelta (regression — same missing-wiring class as onNarration)', () => {
    const multi = new MultiAgentAdapter({ agentIds: ['pi'] });
    const stub = makeStubAdapter();
    (multi as unknown as { wireCallbacks(id: string, a: AgentAdapter): void }).wireCallbacks('pi', stub);

    const seen = vi.fn();
    multi.onFinalizeDelta = seen;
    stub.onFinalizeDelta?.('s1', { content: '✅ done' });

    expect(seen).toHaveBeenCalledWith('s1', { content: '✅ done' });
  });

  it('forwards onMessageDelta and onToolStart (sanity — same wiring path)', () => {
    const multi = new MultiAgentAdapter({ agentIds: ['pi'] });
    const stub = makeStubAdapter();
    (multi as unknown as { wireCallbacks(id: string, a: AgentAdapter): void }).wireCallbacks('pi', stub);

    const onDelta = vi.fn();
    const onTool = vi.fn();
    multi.onMessageDelta = onDelta;
    multi.onToolStart = onTool;

    stub.onMessageDelta?.('s1', { content: 'partial' });
    stub.onToolStart?.('s1', {
      toolName: 'bash',
      args: {},
      toolCallId: 't1',
    });

    expect(onDelta).toHaveBeenCalledWith('s1', { content: 'partial' });
    expect(onTool).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ toolName: 'bash', toolCallId: 't1' }),
    );
  });

  /**
   * Regression: idle-eviction frees the child process but the session persists
   * on disk (pi lazy-resumes). The agent mapping MUST survive eviction, else a
   * later fork/sendMessage falls back to the first adapter (e.g. copilot) and
   * fails with "session.resume: Session not found". Only permanent end
   * (onSessionEnded) drops the mapping.
   */
  it('keeps the agent mapping after eviction, drops it only on session end', () => {
    const multi = new MultiAgentAdapter({ agentIds: ['pi'] });
    const stub = makeStubAdapter();
    (multi as unknown as { wireCallbacks(id: string, a: AgentAdapter): void }).wireCallbacks('pi', stub);
    const map = (multi as unknown as { sessionAgent: Map<string, string> }).sessionAgent;

    stub.onSessionCreated?.({ sessionId: 's1' } as never);
    expect(map.get('s1')).toBe('pi');

    // Eviction must NOT forget which agent owns the (dormant) session.
    stub.onSessionEvicted?.('s1');
    expect(map.get('s1')).toBe('pi');

    // Permanent end clears the mapping.
    stub.onSessionEnded?.('s1', {} as never);
    expect(map.has('s1')).toBe(false);
  });
});
