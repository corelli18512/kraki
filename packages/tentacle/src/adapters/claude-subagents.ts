/** Subagent (Task) tracking for the Claude adapter: steps, grace period, hold until done. */

import { ClaudeAdapter } from './claude.js';
import { logger, type SessionEntry } from './claude-session.js';

export function stopAwaitingSubagents(adapter: ClaudeAdapter, entry: SessionEntry): void {
  entry.awaitingSubagents = false;
  if (entry.subagentSettleTimer) clearTimeout(entry.subagentSettleTimer);
  entry.subagentSettleTimer = undefined;
}

/** Track subagent tasks; once none run while the turn is held open, give
 *  Claude Code a moment to start its continuation, else settle the turn. */
export function trackSubagentTask(adapter: ClaudeAdapter, sessionId: string, msg: Record<string, unknown>): void {
  const entry = adapter.sessions.get(sessionId);
  if (!entry) return;
  const taskId = typeof msg.task_id === 'string' ? msg.task_id : '';
  if (!taskId) return;
  const running = entry.runningSubagents ??= new Set();
  if (msg.subtype === 'task_started') {
    // Only subagents: a background shell (e.g. a dev server) may never end.
    const isAgent = typeof msg.task_type === 'string' ? msg.task_type === 'local_agent' : !!msg.subagent_type;
    if (isAgent) running.add(taskId);
    if (typeof msg.description === 'string' && msg.description) (entry.subagentLabels ??= new Map()).set(taskId, msg.description);
    const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : '';
    const dispatch = toolUseId ? entry.dispatches?.get(toolUseId) : undefined;
    if (dispatch) {
      dispatch.taskId = taskId;
      (entry.taskDispatch ??= new Map()).set(taskId, toolUseId);
    }
    return;
  }
  if (msg.subtype === 'task_notification') reportSubagentTask(adapter, sessionId, entry, taskId, msg);
  const status = msg.subtype === 'task_notification'
    ? msg.status
    : (msg.patch as { status?: unknown } | undefined)?.status;
  if (!['completed', 'failed', 'stopped', 'killed'].includes(String(status))) return;
  const wasRunning = running.delete(taskId);
  // Count each completion once (task_notification), and only while the turn
  // is in its subagent phase: earlier ones are folded into the live turn.
  if (msg.subtype === 'task_notification' && entry.subagentPhase) entry.owedContinuations = (entry.owedContinuations ?? 0) + 1;
  if (wasRunning && running.size === 0 && entry.awaitingSubagents) armSubagentGrace(adapter, sessionId, entry);
}

/** A subagent task finished: record its usage/status, and for a background
 *  subagent (whose tool only returned a receipt) complete its step now,
 *  with its report as the result. */
export function reportSubagentTask(adapter: ClaudeAdapter, sessionId: string, entry: SessionEntry, taskId: string, msg: Record<string, unknown>): void {
  const toolUseId = entry.taskDispatch?.get(taskId) ?? (typeof msg.tool_use_id === 'string' ? msg.tool_use_id : '');
  const dispatch = toolUseId ? entry.dispatches?.get(toolUseId) : undefined;
  if (!dispatch) return;
  const usage = msg.usage as { total_tokens?: number; tool_uses?: number; duration_ms?: number } | undefined;
  const status = msg.status === 'completed' ? 'completed' : msg.status === 'failed' ? 'failed' : 'stopped';
  dispatch.info = {
    ...dispatch.info,
    status,
    ...(typeof usage?.total_tokens === 'number' && { tokens: usage.total_tokens }),
    ...(typeof usage?.tool_uses === 'number' && { toolCount: usage.tool_uses }),
    ...(typeof usage?.duration_ms === 'number' && { durationMs: usage.duration_ms }),
  };
  if (typeof msg.summary === 'string') dispatch.summary = msg.summary;
  if (!dispatch.receipt || dispatch.done) return;
  dispatch.done = true;
  entry.subagentDrafts?.delete(toolUseId);
  adapter.onToolComplete?.(sessionId, {
    ...adapter.lifecycleEvent(entry),
    toolName: 'Agent',
    result: dispatch.summary ?? '',
    toolCallId: toolUseId,
    success: status === 'completed',
    subagent: dispatch.info,
  });
}

export function resetSubagentPhase(adapter: ClaudeAdapter, entry: SessionEntry): void {
  stopAwaitingSubagents(adapter, entry);
  entry.subagentPhase = false;
  entry.owedContinuations = 0;
}

export function armSubagentGrace(adapter: ClaudeAdapter, sessionId: string, entry: SessionEntry): void {
  if (entry.subagentSettleTimer) clearTimeout(entry.subagentSettleTimer);
  entry.subagentSettleTimer = setTimeout(() => {
    if (!entry.awaitingSubagents || adapter.sessions.get(sessionId) !== entry) return;
    logger.info({ sessionId }, 'Claude subagents finished without a continuation turn; settling');
    resetSubagentPhase(adapter, entry);
    adapter.finishTurn(entry);
  }, ClaudeAdapter.SUBAGENT_CONTINUATION_GRACE_MS);
}
