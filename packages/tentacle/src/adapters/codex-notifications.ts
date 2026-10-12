/** Notifications from the Codex app-server: items, subagents (child threads), turn completion. */

import type { SessionUsage } from '@kraki/protocol';
import { type RpcNotification } from './codex-rpc.js';
import type { CodexAdapter } from './codex.js';
import { oneLine, str, codexItemTool, codexItemResult } from './codex-items.js';
import { logger, type CodexSession, type CodexChildThread } from './codex-session.js';

export function handleNotification(adapter: CodexAdapter, n: RpcNotification): void {
  const params = (n.params ?? {}) as Record<string, unknown>;
  const title = adapter.titleThreads.get(str(params.threadId));
  if (title) {
    const item = params.item as { type?: string; text?: string } | undefined;
    if (n.method === 'item/completed' && item?.type === 'agentMessage') title.text = str(item.text);
    if (n.method === 'turn/completed') {
      const status = str((params.turn as { status?: unknown } | undefined)?.status);
      title.done(status === 'completed' ? title.text : null);
    }
    return;
  }
  adapter.learnChildThreads(n, params);
  const s = adapter.sessionForParams(params);
  if (!s) {
    // A subagent thread: its steps show under its dispatch step; its
    // messages and turn lifecycle never drive the owning session.
    const child = adapter.childThreads.get(str(params.threadId));
    const owner = child ? adapter.sessions.get(child.sessionId) : undefined;
    if (owner && child) handleChildNotification(adapter, owner, child, n, params);
    return;
  }

  const turnScoped = n.method === 'turn/started' || n.method === 'turn/completed'
    ? str((params.turn as { id?: unknown } | undefined)?.id)
    : str(params.turnId);
  if (adapter.isStale(s, turnScoped)) {
    logger.debug({ sessionId: s.sessionId, method: n.method }, 'codex: dropped late event from a settled turn');
    return;
  }

  switch (n.method) {
    case 'turn/started': {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id && !s.turn.isSettled) {
        s.activeTurnId = turn.id;
        if (s.abortPending) void adapter.interruptActive(s);
      }
      break;
    }

    case 'item/agentMessage/delta': {
      const delta = str(params.delta);
      if (delta) adapter.onMessageDelta?.(s.sessionId, { content: delta, ...adapter.turnEvent(s) });
      break;
    }

    case 'item/started':
      handleItemStarted(adapter, s, params.item as Record<string, unknown>);
      break;

    case 'item/completed':
      handleItemCompleted(adapter, s, params.item as Record<string, unknown>);
      break;

    case 'error': {
      const error = params.error as { message?: string } | undefined;
      if (params.willRetry !== true && error?.message) s.turn.setError(error.message);
      break;
    }

    case 'thread/tokenUsage/updated': {
      const usage = params.tokenUsage as {
        total?: Record<string, number>;
        last?: Record<string, number>;
      } | undefined;
      if (!usage?.total) break;
      const prev = s.usage;
      const next: SessionUsage = {
        inputTokens: usage.total.inputTokens ?? 0,
        outputTokens: usage.total.outputTokens ?? 0,
        cacheReadTokens: usage.total.cachedInputTokens ?? 0,
        cacheWriteTokens: usage.total.cacheWriteInputTokens ?? 0,
        totalCost: prev?.totalCost ?? 0,
        totalDurationMs: prev?.totalDurationMs ?? 0,
        ...(usage.last?.inputTokens !== undefined && { contextTokens: usage.last.inputTokens }),
      };
      s.usage = next;
      adapter.onUsageUpdate?.(s.sessionId, next);
      break;
    }

    case 'thread/name/updated': {
      const name = str(params.threadName).trim();
      if (name) adapter.onTitleChanged?.(s.sessionId, name);
      break;
    }

    case 'serverRequest/resolved': {
      // Codex withdrew a request itself (e.g. turn interrupted) — retire the card.
      retireWithdrawnRequest(adapter, s, params.requestId);
      break;
    }

    case 'turn/completed':
      handleTurnCompleted(adapter, s, params.turn as Record<string, unknown> | undefined);
      break;

    default:
      break;
  }
}

export function retireWithdrawnRequest(adapter: CodexAdapter, s: CodexSession, rid: unknown): void {
  for (const [id, p] of s.pendingPermissions) {
    if (p.rpcId !== rid) continue;
    s.pendingPermissions.delete(id);
    adapter.onPermissionAutoResolved?.(s.sessionId, id, 'cancelled');
  }
  for (const [id, q] of s.pendingQuestions) {
    if (q.rpcId !== rid) continue;
    s.pendingQuestions.delete(id);
    adapter.onQuestionAutoResolved?.(s.sessionId, id);
  }
}

export function handleItemStarted(adapter: CodexAdapter, s: CodexSession, item: Record<string, unknown> | undefined): void {
  if (!item) return;
  const id = str(item.id);
  const start = (toolName: string, args: Record<string, unknown>) => {
    adapter.flushNarration(s);
    s.tools.set(id, { toolName, args });
    adapter.onToolStart?.(s.sessionId, { toolName, args, toolCallId: id, ...adapter.turnEvent(s) });
  };
  switch (item.type) {
    case 'agentMessage':
      // Each agent message is one prose segment (see item/completed). Only
      // the LAST of a turn is the reply: Codex often emits a commentary
      // message and then the final answer with no tool between them.
      break;
    case 'contextCompaction':
      adapter.onCompaction?.(s.sessionId, { phase: 'start', ...adapter.turnEvent(s) });
      break;
    case 'subAgentActivity':
      adapter.flushNarration(s);
      handleSubagentActivity(adapter, s, item, undefined);
      break;
    case 'collabAgentToolCall':
      noteSpawnPrompt(adapter, item);
      break;
    default: {
      // Tool items (shared with subagent threads). Kraki's own dynamic
      // tools are surfaced from the item/tool/call request instead.
      const tool = codexItemTool(item);
      if (!tool) break;
      if (item.type === 'commandExecution') s.turnCommandItems.add(id);
      start(tool.toolName, tool.args);
      break;
    }
  }
}

/** A spawn call carries the task it gave each new subagent. */
export function noteSpawnPrompt(adapter: CodexAdapter, item: Record<string, unknown>): void {
  const prompt = str(item.prompt);
  if (!prompt || !Array.isArray(item.receiverThreadIds)) return;
  for (const tid of item.receiverThreadIds) {
    const child = adapter.childThreads.get(str(tid));
    if (child && !child.task) child.task = oneLine(prompt);
  }
}

/** subAgentActivity on a session's (or a subagent's) thread: a subagent
 *  started → open its dispatch step; finished → close it with its report. */
export function handleSubagentActivity(adapter: CodexAdapter, s: CodexSession, item: Record<string, unknown>, parentDispatchId: string | undefined): void {
  const tid = str(item.agentThreadId);
  const child = adapter.childThreads.get(tid);
  if (!child || child.sessionId !== s.sessionId) return;
  const kind = str(item.kind);
  if (kind === 'started' && !child.dispatchId) {
    child.dispatchId = `codex-subagent-${tid}`;
    child.parentDispatchId = parentDispatchId;
    adapter.onToolStart?.(s.sessionId, {
      toolName: 'spawn_agent',
      args: { agent: child.label, ...(child.task && { task: child.task }) },
      toolCallId: child.dispatchId,
      ...(parentDispatchId && { parentToolCallId: parentDispatchId }),
      subagent: childInfo(adapter, child, 'running'),
      ...adapter.turnEvent(s),
    });
  } else if ((kind === 'completed' || kind === 'interrupted') && child.dispatchId && !child.done) {
    child.done = true;
    const status = kind === 'completed' ? 'completed' : 'stopped';
    // Close anything the child left open.
    for (const [id, tool] of child.tools) {
      adapter.onToolComplete?.(s.sessionId, { toolName: tool.toolName, result: '', success: false, toolCallId: id, parentToolCallId: child.dispatchId, ...adapter.turnEvent(s) });
    }
    child.tools.clear();
    adapter.onToolComplete?.(s.sessionId, {
      toolName: 'spawn_agent',
      result: child.draft ?? '',
      success: kind === 'completed',
      toolCallId: child.dispatchId,
      ...(child.parentDispatchId && { parentToolCallId: child.parentDispatchId }),
      subagent: childInfo(adapter, child, status),
      ...adapter.turnEvent(s),
    });
    child.draft = undefined;
  }
}

export function childInfo(adapter: CodexAdapter, child: CodexChildThread, status: 'running' | 'completed' | 'failed' | 'stopped'): import('@kraki/protocol').SubagentInfo {
  return {
    name: child.label,
    ...(child.task && { task: child.task }),
    status,
    ...(child.tokens !== undefined && { tokens: child.tokens }),
  };
}

/** A subagent thread's own events: its tool items and prose become steps
 *  under its dispatch; nested spawns become dispatches under it. */
export function handleChildNotification(adapter: CodexAdapter, s: CodexSession, child: CodexChildThread, n: RpcNotification, params: Record<string, unknown>): void {
  if (n.method === 'serverRequest/resolved') {
    retireWithdrawnRequest(adapter, s, params.requestId);
    return;
  }
  if (n.method === 'thread/tokenUsage/updated') {
    const total = (params.tokenUsage as { total?: Record<string, number> } | undefined)?.total;
    if (total) child.tokens = (total.inputTokens ?? 0) + (total.outputTokens ?? 0);
    return;
  }
  const parent = child.dispatchId;
  if (!parent || (n.method !== 'item/started' && n.method !== 'item/completed')) return;
  const item = params.item as Record<string, unknown> | undefined;
  if (!item) return;
  const id = str(item.id);
  const flushDraft = () => {
    if (!child.draft) return;
    adapter.onNarrationTrace?.(s.sessionId, { content: child.draft, parentToolCallId: parent, ...adapter.turnEvent(s) });
    child.draft = undefined;
  };
  if (n.method === 'item/started') {
    if (item.type === 'subAgentActivity') { flushDraft(); handleSubagentActivity(adapter, s, item, parent); return; }
    if (item.type === 'agentMessage') { flushDraft(); return; }
    if (item.type === 'userMessage' && !child.task) {
      const content = Array.isArray(item.content) ? item.content as Array<{ text?: string }> : [];
      const text = content.map((c) => str(c.text)).join(' ').trim();
      if (text) child.task = oneLine(text);
      return;
    }
    const tool = codexItemTool(item);
    if (!tool) return;
    flushDraft();
    child.tools.set(id, { toolName: tool.toolName });
    adapter.onToolStart?.(s.sessionId, { ...tool, toolCallId: id, parentToolCallId: parent, ...adapter.turnEvent(s) });
    return;
  }
  if (item.type === 'subAgentActivity') { handleSubagentActivity(adapter, s, item, parent); return; }
  if (item.type === 'collabAgentToolCall') { noteSpawnPrompt(adapter, item); return; }
  if (item.type === 'agentMessage') {
    const text = str(item.text);
    if (text) child.draft = child.draft ? `${child.draft}\n\n${text}` : text;
    return;
  }
  const tracked = child.tools.get(id);
  const res = codexItemResult(item);
  if (!tracked || !res) return;
  child.tools.delete(id);
  adapter.onToolComplete?.(s.sessionId, { toolName: tracked.toolName, ...res, toolCallId: id, parentToolCallId: parent, ...adapter.turnEvent(s) });
}

export function handleItemCompleted(adapter: CodexAdapter, s: CodexSession, item: Record<string, unknown> | undefined): void {
  if (!item) return;
  const id = str(item.id);
  const complete = (result: string, success: boolean) => {
    const tracked = s.tools.get(id);
    if (!tracked) return;
    s.tools.delete(id);
    adapter.onToolComplete?.(s.sessionId, { toolName: tracked.toolName, result, success, toolCallId: id, ...adapter.turnEvent(s) });
  };
  switch (item.type) {
    case 'agentMessage':
      s.turn.proseSegment(str(item.text));
      break;
    case 'contextCompaction':
      adapter.onCompaction?.(s.sessionId, { phase: 'end', ...adapter.turnEvent(s) });
      break;
    default: {
      const res = codexItemResult(item);
      if (res) complete(res.result, res.success);
      break;
    }
  }
}

export function handleTurnCompleted(adapter: CodexAdapter, s: CodexSession, turn: Record<string, unknown> | undefined): void {
  if (s.turn.isSettled) return;
  const status = str(turn?.status);
  const turnError = (turn?.error as { message?: string } | null | undefined)?.message;

  // Anything Codex still has open for this turn is moot now.
  adapter.dropPendingCards(s, false);
  for (const [id, t] of s.tools) {
    adapter.onToolComplete?.(s.sessionId, { toolName: t.toolName, result: '', success: false, toolCallId: id, ...adapter.turnEvent(s) });
  }
  s.tools.clear();

  // A user stop ends silently (RelayClient owns it); a failed turn reports
  // its error instead of a reply; a completed turn's reply wins over an
  // error Codex recovered from.
  const failed = status === 'failed';
  const error = failed ? (turnError || s.turn.pendingError || 'Codex turn failed') : undefined;
  if (!failed) s.turn.clearError();
  const duration = typeof turn?.durationMs === 'number' ? turn.durationMs : 0;
  if (duration && s.usage) {
    s.usage = { ...s.usage, totalDurationMs: s.usage.totalDurationMs + duration };
    adapter.onUsageUpdate?.(s.sessionId, s.usage);
  }
  adapter.finalizeTurn(s, error);
}
