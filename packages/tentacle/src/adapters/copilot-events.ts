/** Copilot session events → Kraki: messages, deltas, tools, subagents, compaction, idle, errors (wireEvents). */

import type { CopilotSession } from '@github/copilot-sdk';
import { canonicalArtifactToolName } from './tool-name.js';
import type { CopilotAdapter } from './copilot.js';
import { touchSession } from './copilot-eviction.js';
import { basenameSafe } from './copilot-paths.js';
import { logger } from './copilot-session.js';

export function wireEvents(adapter: CopilotAdapter, sessionId: string, session: CopilotSession): void {
  if (!adapter.turnErrorReported.has(sessionId)) {
    adapter.turnErrorReported.set(sessionId, false);
  }

  // Events from a subagent (task tool) carry a top-level `agentId`; the root
  // agent's never do. A subagent's prose, turn boundaries and errors are its
  // own — it reports back through the task tool's result — so they must not
  // reach the parent's reply or turn state. Its tool calls still show as steps.
  const fromSubagent = (event: unknown) => !!(event as { agentId?: string }).agentId;
  // The subagent instance id is the toolCallId of the task call that started it.
  const parentOf = (event: unknown): string | undefined => {
    const e = event as { agentId?: string; data?: { parentToolCallId?: string } };
    return e.agentId || e.data?.parentToolCallId || undefined;
  };

  // Subagent lifecycle: name the dispatching task step and track its status.
  const subagentEvent = (status: 'running' | 'completed' | 'failed') => (event: unknown) => {
    const d = (event as { data?: Record<string, unknown> }).data ?? {};
    const id = typeof d.toolCallId === 'string' ? d.toolCallId : '';
    if (!id) return;
    const prev = adapter.subagents.get(id);
    const name = (typeof d.agentDisplayName === 'string' && d.agentDisplayName)
      || (typeof d.agentName === 'string' && d.agentName) || prev?.name || 'subagent';
    adapter.subagents.set(id, {
      ...prev,
      name: prev?.name ?? name,
      status,
      ...(typeof d.totalTokens === 'number' && { tokens: d.totalTokens }),
      ...(typeof d.totalToolCalls === 'number' && { toolCount: d.totalToolCalls }),
      ...(typeof d.durationMs === 'number' && { durationMs: d.durationMs }),
    });
  };
  session.on('subagent.started' as never, subagentEvent('running') as never);
  session.on('subagent.completed' as never, subagentEvent('completed') as never);
  session.on('subagent.failed' as never, subagentEvent('failed') as never);

  session.on('assistant.message_delta', (event) => {
    if (fromSubagent(event)) return;
    adapter.onMessageDelta?.(sessionId, { content: event.data.deltaContent, ...adapter.lifecycleEvent(sessionId) });
  });

  session.on('assistant.message', (event) => {
    // A subagent's prose is shown in its own steps, never in the reply.
    if (event.data.content && fromSubagent(event)) {
      const owner = parentOf(event);
      if (owner) {
        const prev = adapter.subagentDrafts.get(owner)?.text;
        adapter.subagentDrafts.set(owner, { sessionId, text: prev ? `${prev}\n${event.data.content}` : event.data.content });
      }
      return;
    }
    // Skip empty messages (SDK sends these before tool calls)
    if (event.data.content && !fromSubagent(event)) {
      adapter.turnHasOutput.set(sessionId, true);
      touchSession(adapter, sessionId);
      // Draft-bubble model: buffer prose instead of graduating each message
      // to its own permanent bubble. Accumulate consecutive messages so a
      // multi-part answer isn't lost. Flushed as narration (if a tool
      // follows) or as the single conclusion bubble (at turn end/idle).
      adapter.sessions.get(sessionId)?.turn.appendProse(event.data.content);
    }
  });

  session.on('tool.execution_start', (event) => {
    const data = event.data as unknown as Record<string, unknown>;
    // report_intent is a UI hint only — drop it from the message stream.
    if (data.toolName === 'report_intent') return;
    // A tool follows any buffered prose → that prose was narration.
    // A subagent's tool says nothing about the parent's draft.
    if (!fromSubagent(event)) adapter.flushNarration(sessionId);
    adapter.turnHasOutput.set(sessionId, true);
    touchSession(adapter, sessionId);
    if (data.mcpServerName) {
      logger.info({ mcpServer: data.mcpServerName, mcpTool: data.mcpToolName }, `[MCP tool] ${data.mcpServerName}/${data.mcpToolName}`);
    }
    const args = (data.args ?? data.arguments ?? {}) as Record<string, unknown>;
    const toolCallId = data.toolCallId as string | undefined;
    if (toolCallId) {
      adapter.pendingToolArgs.set(toolCallId, args);
      // Stash tool identity for tool.execution_complete, which only carries
      // toolCallId (verified via live SDK spike).
      adapter.pendingToolIdentity.set(toolCallId, {
        toolName: data.toolName as string | undefined,
        mcpServerName: data.mcpServerName as string | undefined,
        mcpToolName: data.mcpToolName as string | undefined,
      });
      let inflight = adapter.sessionToolCallIds.get(sessionId);
      if (!inflight) {
        inflight = new Set();
        adapter.sessionToolCallIds.set(sessionId, inflight);
      }
      inflight.add(toolCallId);
    }
    const protocolToolName = canonicalArtifactToolName(
      data.toolName as string,
      data.mcpServerName as string | undefined,
      data.mcpToolName as string | undefined,
    );
    // A task call that started a subagent (subagent.started precedes it).
    let subagent = toolCallId ? adapter.subagents.get(toolCallId) : undefined;
    if (toolCallId && (subagent || data.toolName === 'task')) {
      const task = typeof args.description === 'string' ? args.description : undefined;
      subagent = { name: subagent?.name ?? (typeof args.agent_type === 'string' ? args.agent_type : 'subagent'), ...subagent, ...(task && { task }), status: 'running' };
      adapter.subagents.set(toolCallId, subagent);
    }
    const parentToolCallId = parentOf(event);
    const draft = parentToolCallId ? adapter.subagentDrafts.get(parentToolCallId) : undefined;
    if (parentToolCallId && draft) {
      adapter.subagentDrafts.delete(parentToolCallId);
      adapter.onNarrationTrace?.(sessionId, { content: draft.text, parentToolCallId, ...adapter.lifecycleEvent(sessionId) });
    }
    adapter.onToolStart?.(sessionId, {
      ...adapter.lifecycleEvent(sessionId),
      toolName: protocolToolName,
      args,
      toolCallId,
      ...(parentToolCallId && { parentToolCallId }),
      ...(subagent && { subagent }),
    });
  });

  session.on('tool.execution_complete', (event) => {
    const data = event.data as unknown as Record<string, unknown>;
    const toolCallId = data.toolCallId as string | undefined;
    const identity = toolCallId ? adapter.pendingToolIdentity.get(toolCallId) : undefined;
    const rawToolName = identity?.toolName ?? (data.toolName as string | undefined) ?? 'tool';
    const toolName = canonicalArtifactToolName(rawToolName, identity?.mcpServerName, identity?.mcpToolName);
    const clearInflight = () => {
      if (!toolCallId) return;
      adapter.pendingToolIdentity.delete(toolCallId);
      adapter.pendingToolArgs.delete(toolCallId);
      const inflight = adapter.sessionToolCallIds.get(sessionId);
      if (inflight) {
        inflight.delete(toolCallId);
        if (inflight.size === 0) adapter.sessionToolCallIds.delete(sessionId);
      }
    };
    if (toolName === 'report_intent') {
      clearInflight();
      return;
    }
    const rawResult = data.result;
    const resultObj = typeof rawResult === 'object' && rawResult !== null
      ? rawResult as Record<string, unknown>
      : null;
    let result = resultObj?.content as string ?? (typeof rawResult === 'string' ? rawResult : (data.output as string ?? ''));
    if (!result && data.error) {
      const errObj = typeof data.error === 'object' && data.error !== null
        ? data.error as Record<string, unknown>
        : null;
      result = (errObj?.message as string) ?? (typeof data.error === 'string' ? data.error : '');
    }

    // Extract image content blocks — ONLY for the kraki-show_image MCP tool.
    // All other tools' image bytes (notably `view` on a .png) are deliberately
    // dropped here per the v1 design: only `kraki-show_image` surfaces images
    // to the client. The file-path fallback (re-read image from disk when SDK
    // strips bytes) has been removed.
    const isKrakiShowImage =
      identity?.mcpServerName === 'kraki' && identity?.mcpToolName === 'show_image';

    let attachments: import('@kraki/protocol').Attachment[] | undefined;
    if (isKrakiShowImage && adapter.attachmentStore) {
      const contentBlocks = resultObj?.contents as Array<Record<string, unknown>> | undefined;
      const args = toolCallId ? adapter.pendingToolArgs.get(toolCallId) ?? {} : {};
      const caption = typeof args.caption === 'string' && args.caption.trim()
        ? args.caption.trim()
        : undefined;
      const path = typeof args.path === 'string' ? args.path : undefined;
      const refs: import('@kraki/protocol').ContentRef[] = [];
      if (Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
          if (
            block.type === 'image' &&
            typeof block.data === 'string' &&
            typeof block.mimeType === 'string'
          ) {
            try {
              const bytes = Buffer.from(block.data, 'base64');
              const ref = adapter.attachmentStore.put(sessionId, bytes, block.mimeType, {
                ...(path && { name: basenameSafe(path) }),
                ...(caption && { caption }),
              });
              refs.push(ref);
            } catch (err) {
              logger.warn({ err, sessionId }, 'failed to store show_image attachment');
            }
          }
        }
      }
      if (refs.length > 0) {
        attachments = refs;
      }
    }

    // Clean up tracked state for this tool call
    clearInflight();

    let subagent = toolCallId ? adapter.subagents.get(toolCallId) : undefined;
    if (toolCallId) adapter.subagentDrafts.delete(toolCallId);
    if (subagent && toolCallId) {
      if (subagent.status === 'running') subagent = { ...subagent, status: data.success === false ? 'failed' : 'completed' };
      adapter.subagents.delete(toolCallId);
    }
    const parentToolCallId = parentOf(event);
    adapter.onToolComplete?.(sessionId, {
      ...adapter.lifecycleEvent(sessionId),
      toolName,
      result,
      toolCallId,
      success: data.success as boolean | undefined,
      attachments,
      ...(parentToolCallId && { parentToolCallId }),
      ...(subagent && { subagent }),
    });
  });

  session.on('session.idle', () => {
    const turn = adapter.sessions.get(sessionId)?.turn;
    if (!turn) return;
    if (turn.isAborted) {
      // RelayClient owns a user stop's terminal boundary (turn_status
      // user_abort + idle aborted). Settle silently: the half-written draft
      // is not a reply, and an idle here would land before the abort status.
      turn.settleSilently();
      adapter.signalFlushComplete(sessionId);
      return;
    }

    // The buffered prose becomes the turn's reply, then idle (once). An
    // error still being classified must be reported first, or the turn ends
    // looking clean. Copilot reports errors as they happen (session.error),
    // so a reply it still produced afterwards is kept.
    const finish = () => {
      turn.finish();
      adapter.signalFlushComplete(sessionId);
    };
    const pendingError = adapter.pendingErrorReports.get(sessionId);
    if (pendingError) void pendingError.finally(finish);
    else finish();
  });

  session.on('assistant.turn_start', (event) => {
    if (fromSubagent(event)) return;
    adapter.sessions.get(sessionId)?.turn.captureTurnId();
    adapter.turnHasOutput.set(sessionId, false);
    // Only reset if no error was reported before this turn started
    // (session.error can fire before turn_start in error recovery paths)
    if (!adapter.turnErrorReported.get(sessionId)) {
      adapter.turnErrorReported.set(sessionId, false);
    }
  });

  session.on('session.error', async (event) => {
    const data = event.data as unknown as Record<string, unknown>;
    const message = (data.message as string) ?? 'Unknown session error';
    const errorType = data.errorType as string | undefined;
    logger.error({ sessionId, errorType, statusCode: data.statusCode, agentId: (event as { agentId?: string }).agentId }, `session.error: ${message}`);
    // A subagent's failure reaches the parent as the task tool's result.
    if (fromSubagent(event)) return;
    if (!adapter.turnErrorReported.get(sessionId)) {
      adapter.turnErrorReported.set(sessionId, true);
      const status = typeof data.statusCode === 'number' ? data.statusCode : undefined;
      // A request the service answered (bad model, rate limit, outage) is
      // reported as is, at once. Only a possible sign-out needs the probe.
      if (status !== undefined && status !== 401 && status !== 403) {
        adapter.emitError(sessionId, message);
        return;
      }
      const report = (async () => {
        if (await adapter.probeRuntime() === 'auth_error') adapter.fireAuthError(sessionId, message);
        else adapter.emitError(sessionId, message);
      })();
      adapter.pendingErrorReports.set(sessionId, report);
      try { await report; } finally {
        if (adapter.pendingErrorReports.get(sessionId) === report) adapter.pendingErrorReports.delete(sessionId);
      }
    }
  });

  // Which model Copilot actually runs is Copilot's decision (`auto`, plan
  // limits, fallbacks). Kraki relays; it never aborts a turn over it.
  session.on((event) => {
    if (event.type !== 'session.tools_updated') return;
    const actualModel = (event.data as unknown as Record<string, unknown>)?.model as string | undefined;
    const requested = adapter.userRequestedModels.get(sessionId);
    if (actualModel && requested && actualModel !== requested) {
      logger.info({ sessionId, requested, actualModel }, 'Copilot is running a different model than requested');
    }
  });

  session.on('session.info', (event) => {
    const data = event.data as unknown as Record<string, unknown>;
    const category = data.category as string | undefined;
    if (category === 'mcp') {
      logger.info(`[MCP] ${data.message}`);
    } else {
      logger.debug(`[info:${category}] ${data.message}`);
    }
  });

  session.on('session.warning', (event) => {
    const data = event.data as unknown as Record<string, unknown>;
    const category = data.category as string | undefined;
    logger.warn(`[warning:${category}] ${data.message}`);
  });

  session.on('assistant.turn_end', async (event) => {
    const data = event.data as unknown as Record<string, unknown>;
    const reason = data?.reason;
    if (fromSubagent(event)) {
      // The parent sees the failure as the task tool's result.
      if (reason === 'error') logger.warn({ sessionId, agentId: (event as { agentId?: string }).agentId, error: data?.error }, 'Copilot subagent turn ended with error');
      return;
    }
    if (reason === 'error') {
      const errorMsg = (data?.error as string) ?? 'Unknown agent error';
      adapter.turnErrorReported.set(sessionId, true);
      if (await adapter.probeRuntime() === 'auth_error') {
        adapter.fireAuthError(sessionId, errorMsg);
      } else {
        adapter.emitError(sessionId, errorMsg);
      }
    }

  });

  session.on('session.title_changed', (event) => {
    const data = event.data as unknown as Record<string, unknown>;
    const title = data?.title as string | undefined;
    if (title) {
      adapter.nativeTitles.set(sessionId, title);
      adapter.onTitleChanged?.(sessionId, title);
    }
  });

  session.on('assistant.usage', (event) => {
    const data = event.data as unknown as Record<string, unknown>;
    const owner = fromSubagent(event) ? parentOf(event) : undefined;
    const sub = owner ? adapter.subagents.get(owner) : undefined;
    if (owner && sub) {
      const used = ((data.inputTokens as number) ?? 0) + ((data.outputTokens as number) ?? 0);
      adapter.subagents.set(owner, { ...sub, tokens: (sub.tokens ?? 0) + used });
    }
    const prev = adapter.sessionUsage.get(sessionId) ?? {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      totalCost: 0, totalDurationMs: 0,
    };
    const updated = {
      inputTokens: prev.inputTokens + ((data.inputTokens as number) ?? 0),
      outputTokens: prev.outputTokens + ((data.outputTokens as number) ?? 0),
      cacheReadTokens: prev.cacheReadTokens + ((data.cacheReadTokens as number) ?? 0),
      cacheWriteTokens: prev.cacheWriteTokens + ((data.cacheWriteTokens as number) ?? 0),
      totalCost: prev.totalCost + ((data.cost as number) ?? 0),
      totalDurationMs: prev.totalDurationMs + ((data.duration as number) ?? 0),
      // A subagent's prompt is its own window, not the parent's.
      contextTokens: fromSubagent(event) ? prev.contextTokens : (data.inputTokens as number) ?? prev.contextTokens,
    };
    adapter.sessionUsage.set(sessionId, updated);
    adapter.onUsageUpdate?.(sessionId, updated);
  });
}
