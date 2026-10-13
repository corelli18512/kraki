/**
 * Claude's canUseTool cancellation signal: when the SDK withdraws a pending
 * permission or AskUserQuestion request (e.g. its subagent is stopped), the
 * card closes and a later answer is no longer accepted.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude.js';
import { makeCanUseToolHandler } from '../adapters/claude-permissions.js';
import { TurnTracker } from '../adapters/turn-tracker.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function setup() {
  const adapter = new ClaudeAdapter({});
  const pendingPermissions = new Map();
  const pendingQuestions = new Map();
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { pendingPermissions, pendingQuestions, turn: new TurnTracker(adapter, 's1') });
  adapter.sessionModes.set('s1', 'safe');
  const onPermissionRequest = vi.fn();
  const onPermissionAutoResolved = vi.fn();
  const onQuestionRequest = vi.fn();
  const onQuestionAutoResolved = vi.fn();
  Object.assign(adapter, { onPermissionRequest, onPermissionAutoResolved, onQuestionRequest, onQuestionAutoResolved });
  const canUseTool = makeCanUseToolHandler(adapter, 's1', pendingPermissions, pendingQuestions);
  return { adapter, canUseTool, pendingPermissions, pendingQuestions, onPermissionRequest, onPermissionAutoResolved, onQuestionRequest, onQuestionAutoResolved };
}

describe('Claude canUseTool cancellation', () => {
  it('a withdrawn permission closes its card and settles', async () => {
    const t = setup();
    const abort = new AbortController();
    const decision = t.canUseTool('Bash', { command: 'rm -rf build' }, { signal: abort.signal, toolUseID: 'tu1' });
    const permId = t.onPermissionRequest.mock.calls[0][1].id;
    abort.abort();
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'Request cancelled' });
    expect(t.onPermissionAutoResolved).toHaveBeenCalledWith('s1', permId, 'cancelled');
    expect(await t.adapter.respondToPermission('s1', permId, 'approve')).toBe('not_found');
  });

  it('an answered permission ignores a later abort', async () => {
    const t = setup();
    const abort = new AbortController();
    const decision = t.canUseTool('Bash', { command: 'ls -la' }, { signal: abort.signal, toolUseID: 'tu1' });
    const permId = t.onPermissionRequest.mock.calls[0][1].id;
    expect(await t.adapter.respondToPermission('s1', permId, 'approve')).toBe('accepted');
    abort.abort();
    await expect(decision).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } });
    expect(t.onPermissionAutoResolved).not.toHaveBeenCalled();
  });

  it('a withdrawn AskUserQuestion closes its open card', async () => {
    const t = setup();
    const abort = new AbortController();
    const answer = t.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?' }] }, { signal: abort.signal, toolUseID: 'tu2' });
    const qId = t.onQuestionRequest.mock.calls[0][1].id;
    abort.abort();
    await expect(answer).resolves.toEqual({ behavior: 'deny', message: 'Request cancelled' });
    expect(t.onQuestionAutoResolved).toHaveBeenCalledWith('s1', qId);
    expect(await t.adapter.respondToQuestion('s1', qId, 'this', true)).toBe('not_found');
  });
});
