/** Claude SDK messages → Kraki: text, deltas, tools, compaction, results and errors (handleSDKMessage). */

import type { SessionUsage } from '@kraki/protocol';
import { canonicalArtifactToolName } from './tool-name.js';
import type { ClaudeAdapter } from './claude.js';
import { armSubagentGrace, resetSubagentPhase, stopAwaitingSubagents, trackSubagentTask } from './claude-subagents.js';
import { normalizeClaudeSDKError, preferClaudeError } from './claude-errors.js';
import { logger, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage, type SDKSystemMessage, type SDKPartialAssistantMessage, type SDKUserMessage, CLAUDE_DISPATCH_TOOLS } from './claude-session.js';

/**
 * Route a single SDKMessage to the appropriate adapter callback.
 */
export function handleSDKMessage(adapter: ClaudeAdapter, sessionId: string, msg: SDKMessage): void {
  // Held-open turn: any parent activity means Claude Code started the
  // continuation turn, which now runs (and settles) like a normal turn.
  const held = adapter.sessions.get(sessionId);
  if (held?.awaitingSubagents) {
    const m = msg as unknown as { type: string; subtype?: string; parent_tool_use_id?: string | null };
    const parentActivity = (m.type === 'system' && (m.subtype === 'init' || (m.subtype === 'status' && (msg as unknown as { status?: string }).status === 'requesting')))
      || ((m.type === 'assistant' || m.type === 'stream_event') && !m.parent_tool_use_id)
      || m.type === 'result';
    if (parentActivity) stopAwaitingSubagents(adapter, held);
  }
  switch (msg.type) {
    case 'system': {
      const sysMsg = msg as SDKSystemMessage & { subtype?: string };
      if (sysMsg.subtype === 'init') {
        const sdkSessionId = sysMsg.session_id;
        if (sdkSessionId) {
          adapter.sdkSessionIds.set(sessionId, sdkSessionId);
          // Persist the SDK's own session UUID — the value its `resume`
          // option expects — so a fresh daemon can re-attach this transcript.
          adapter.persistMeta(sessionId, { sdkSessionId, forkFrom: undefined });
          if (sdkSessionId !== sessionId) {
            const entry = adapter.sessions.get(sessionId);
            if (entry) entry.sessionId = sdkSessionId;
          }
        }
        adapter.cacheModelsFromInit(sysMsg);
        logger.debug({ sessionId, sdkSessionId }, 'SDK session initialized');
      } else if (sysMsg.subtype === 'status') {
        // Claude Code's native compaction state (SDKStatusMessage).
        const st = msg as unknown as { status?: string | null; compact_result?: string; compact_error?: string };
        if (st.status === 'compacting') {
          adapter.emitCompaction(sessionId, { phase: 'start', reason: 'threshold' });
        } else if (st.compact_result) {
          adapter.emitCompaction(sessionId, {
            phase: 'end',
            ...(st.compact_result === 'failed' && { aborted: true, errorMessage: st.compact_error ?? 'Compaction failed' }),
          });
        }
      } else if ((sysMsg.subtype as string) === 'compact_boundary') {
        const meta = (msg as unknown as { compact_metadata?: { trigger?: string } }).compact_metadata;
        const reason = meta?.trigger === 'manual' ? 'manual' as const : 'threshold' as const;
        // A boundary without a preceding status still completes a compaction.
        adapter.emitCompaction(sessionId, { phase: 'start', reason });
        adapter.emitCompaction(sessionId, { phase: 'end', reason });
      } else if (['task_started', 'task_notification', 'task_updated'].includes(sysMsg.subtype as string)) {
        trackSubagentTask(adapter, sessionId, msg as unknown as Record<string, unknown>);
      } else if (sysMsg.subtype === 'files_persisted') {
        // The SDK finished writing session files to disk — safe to
        // resume watching the session directory for external changes.
        adapter.onFlushComplete?.(sessionId);
      }
      break;
    }

    case 'assistant': {
      const assistantMsg = msg as SDKAssistantMessage;
      // A subagent (Task/Agent tool) message: it carries the dispatching
      // tool call's id. Its prose and errors belong to the subagent, never
      // to the parent's reply; its tool calls still show as steps.
      const fromSubagent = !!assistantMsg.parent_tool_use_id;
      if (assistantMsg.error) {
        if (fromSubagent) break;
        const entry = adapter.sessions.get(sessionId);
        const normalized = normalizeClaudeSDKError(assistantMsg as unknown as Record<string, unknown>);
        if (entry) entry.pendingError = preferClaudeError(entry.pendingError, normalized);
        break;
      }

      const betaMessage = assistantMsg.message;
      if (!betaMessage?.content) break;

      const entry = adapter.sessions.get(sessionId);
      for (const block of betaMessage.content) {
        if (block.type === 'text' && (block as { text?: string }).text) {
          if (fromSubagent) {
            // forwardSubagentText: the subagent's own prose, shown in its steps.
            if (entry) {
              const drafts = entry.subagentDrafts ??= new Map();
              const owner = assistantMsg.parent_tool_use_id!;
              const prev = drafts.get(owner);
              const text = (block as { text: string }).text;
              drafts.set(owner, prev ? `${prev}\n${text}` : text);
            }
            continue;
          }
          // Draft-bubble model: buffer prose instead of graduating each block
          // to its own permanent bubble. Accumulate consecutive text blocks so
          // multi-block answers aren't lost. Flushed as narration (if a tool
          // follows) or as the single conclusion bubble (at turn end).
          if (entry) {
            entry.turn.appendProse((block as { text: string }).text);
          } else {
            // No session entry (shouldn't happen) — fall back to direct bubble.
            adapter.onMessage?.(sessionId, { content: (block as { text: string }).text });
          }
        } else if (block.type === 'tool_use') {
          // A tool follows the buffered prose → that prose was narration.
          // A subagent's tool says nothing about the parent's draft.
          if (!fromSubagent) adapter.flushNarration(sessionId);
          const toolBlock = block as { name: string; input?: Record<string, unknown>; id: string };
          const args = (toolBlock.input ?? {}) as Record<string, unknown>;

          // Track tool call for correlating with tool result
          let sessionTools = adapter.pendingToolCalls.get(sessionId);
          if (!sessionTools) {
            sessionTools = new Map();
            adapter.pendingToolCalls.set(sessionId, sessionTools);
          }
          const canonicalToolName = canonicalArtifactToolName(toolBlock.name);
          const parentToolCallId = assistantMsg.parent_tool_use_id ?? undefined;
          const draft = parentToolCallId ? entry?.subagentDrafts?.get(parentToolCallId) : undefined;
          if (parentToolCallId && draft) {
            entry!.subagentDrafts!.delete(parentToolCallId);
            adapter.onNarrationTrace?.(sessionId, { ...adapter.lifecycleEvent(entry), content: draft, parentToolCallId });
          }
          sessionTools.set(toolBlock.id, { toolName: canonicalToolName, args, ...(parentToolCallId && { parentToolCallId }) });

          let subagent: import('@kraki/protocol').SubagentInfo | undefined;
          if (entry && CLAUDE_DISPATCH_TOOLS.has(toolBlock.name)) {
            const task = typeof args.description === 'string' ? args.description : undefined;
            const name = typeof args.subagent_type === 'string' && args.subagent_type ? args.subagent_type : 'subagent';
            subagent = { name, ...(task && { task }), status: 'running' };
            (entry.dispatches ??= new Map()).set(toolBlock.id, { info: subagent });
          }

          adapter.onToolStart?.(sessionId, {
            ...adapter.lifecycleEvent(entry),
            toolName: canonicalToolName,
            args,
            toolCallId: toolBlock.id,
            ...(parentToolCallId && { parentToolCallId }),
            ...(subagent && { subagent }),
          });
        }
      }

      // Track usage. The SDK splits one API response into several
      // assistant messages (one per content block) that all carry the
      // response's full usage: count each response id once.
      const responseId = (betaMessage as { id?: string }).id;
      if (betaMessage.usage && (!responseId || adapter.lastCountedResponse.get(sessionId) !== responseId)) {
        if (responseId) adapter.lastCountedResponse.set(sessionId, responseId);
        adapter.updateUsage(sessionId, betaMessage.usage as unknown as Record<string, unknown>, fromSubagent);
      }
      break;
    }

    case 'stream_event': {
      const partial = msg as SDKPartialAssistantMessage;
      // Subagent stream (forwardSubagentText): not the parent's reply.
      if (partial.parent_tool_use_id) break;
      const event = partial.event as unknown as Record<string, unknown>;

      if (event.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          adapter.onMessageDelta?.(sessionId, { content: delta.text, ...adapter.lifecycleEvent(adapter.sessions.get(sessionId)) });
        }
      }
      break;
    }

    case 'result': {
      const result = msg as SDKResultMessage;
      const resultAny = result as unknown as Record<string, unknown>;
      const entry = adapter.sessions.get(sessionId);
      if (entry?.staleResults) {
        // Late result of a stopped turn: it must not settle the new turn.
        entry.staleResults -= 1;
        entry.turn.discardProse();
        entry.pendingError = undefined;
        break;
      }
      if (entry?.turn.isSettled) break;
      if (entry?.compacting) adapter.emitCompaction(sessionId, { phase: 'end' });
      // A result during the subagent phase ends one continuation turn.
      if (entry?.subagentPhase && entry.owedContinuations) entry.owedContinuations -= 1;
      const holdForSubagents = !resultAny.is_error && !entry?.turn.isAborted
        && (!!entry?.runningSubagents?.size || !!entry?.owedContinuations);
      if (entry && !holdForSubagents) resetSubagentPhase(adapter, entry);

      if (entry?.turn.isAborted) {
        // RelayClient owns this turn's terminal boundary (see abortSession).
        entry.pendingError = undefined;
        entry.turn.settleSilently();
        break;
      }

      if (resultAny.is_error) {
        const normalized = normalizeClaudeSDKError(resultAny);
        const error = preferClaudeError(entry?.pendingError, normalized);
        if (entry) entry.pendingError = error;
        else adapter.onError?.(sessionId, { message: error.message });
      } else {
        if (entry) entry.pendingError = undefined;
        // Prose so far ("waiting for the subagent…") is an intermediate step.
        if (holdForSubagents) entry?.turn.holdOpen();
      }

      // Update final usage
      if (resultAny.usage) {
        const u = resultAny.usage as Record<string, unknown>;
        const prev = adapter.sessionUsage.get(sessionId) ?? {
          inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          totalCost: 0, totalDurationMs: 0,
        };
        void u;
        // Token counters are accumulated per assistant message (updateUsage).
        // Replacing them with this turn's result usage threw away every
        // earlier turn; the result only adds cost and duration.
        // total_cost_usd is cumulative for the current query, which starts
        // over when the query restarts (lastQueryCost is reset then): add
        // only what it grew by. It used to replace the session total.
        const queryCost = resultAny.total_cost_usd as number | undefined;
        const lastQueryCost = adapter.lastQueryCost.get(sessionId) ?? 0;
        const addedCost = typeof queryCost === 'number' ? Math.max(0, queryCost - lastQueryCost) : 0;
        if (typeof queryCost === 'number') adapter.lastQueryCost.set(sessionId, queryCost);
        const updated: SessionUsage = {
          ...prev,
          totalCost: (prev.totalCost ?? 0) + addedCost,
          totalDurationMs: ((resultAny.duration_ms as number) ?? 0) + (prev.totalDurationMs ?? 0),
        };
        adapter.sessionUsage.set(sessionId, updated);
        adapter.onUsageUpdate?.(sessionId, updated);
      }

      // Background subagents are still running: Claude Code will wake the
      // parent when they finish. Keep the Kraki turn open for that answer.
      if (holdForSubagents && entry) {
        entry.awaitingSubagents = true;
        entry.subagentPhase = true;
        if (!entry.runningSubagents?.size) armSubagentGrace(adapter, sessionId, entry);
        logger.info({ sessionId, running: entry.runningSubagents?.size }, 'Claude turn held open for background subagents');
        break;
      }

      // The result is the authoritative turn boundary: the reply (or the
      // error), then idle. A tool-only turn is anchored centrally by RelayClient.
      if (entry) adapter.finishTurn(entry);
      else adapter.onIdle?.(sessionId);

      break;
    }

    case 'user': {
      const entry = adapter.sessions.get(sessionId);
      entry?.turn.captureTurnId();
      // User messages include tool_result content blocks when tools complete.
      // Extract tool results and fire tool_complete callbacks.
      const userMsg = msg as SDKUserMessage;
      const userMessage = userMsg.message as { content?: unknown };
      if (Array.isArray(userMessage?.content)) {
        for (const block of userMessage.content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            const toolCallId = b.tool_use_id;
            const tracked = adapter.pendingToolCalls.get(sessionId)?.get(toolCallId);

            let result = '';
            const imageAttachments: import('@kraki/protocol').Attachment[] = [];
            if (typeof b.content === 'string') {
              result = b.content;
            } else if (Array.isArray(b.content)) {
              const blocks = b.content as Array<Record<string, unknown>>;
              result = blocks
                .filter(c => c.type === 'text' && typeof c.text === 'string')
                .map(c => c.text as string)
                .join('\n');

              // Extract image blocks only from Kraki's explicit show_image
              // tool. Other tools may return image-shaped diagnostic blocks,
              // but they do not own user-visible artifact semantics.
              const isKrakiShowImage = tracked?.toolName === 'show_image';
              if (adapter.attachmentStore && isKrakiShowImage) {
                for (const c of blocks) {
                  if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string') {
                    try {
                      const bytes = Buffer.from(c.data, 'base64');
                      const ref = adapter.attachmentStore.put(sessionId, bytes, c.mimeType, {});
                      imageAttachments.push(ref);
                    } catch (err) {
                      logger.warn({ err, sessionId }, 'failed to store image attachment');
                    }
                  }
                  // Also handle Anthropic API image format: { type: 'image', source: { type: 'base64', media_type, data } }
                  if (c.type === 'image' && typeof c.source === 'object' && c.source !== null) {
                    const src = c.source as Record<string, unknown>;
                    if (src.type === 'base64' && typeof src.data === 'string' && typeof src.media_type === 'string') {
                      try {
                        const bytes = Buffer.from(src.data, 'base64');
                        const ref = adapter.attachmentStore.put(sessionId, bytes, src.media_type, {});
                        imageAttachments.push(ref);
                      } catch (err) {
                        logger.warn({ err, sessionId }, 'failed to store image attachment');
                      }
                    }
                  }
                }
              }
            }

            const dispatch = entry?.dispatches?.get(toolCallId);
            if (dispatch && !(dispatch.taskId && entry?.runningSubagents?.has(dispatch.taskId))) entry?.subagentDrafts?.delete(toolCallId);
            if (dispatch && dispatch.taskId && entry?.runningSubagents?.has(dispatch.taskId) && !b.is_error) {
              // Background subagent: this is only its launch receipt. The
              // step stays running until the task reports (task_notification).
              dispatch.receipt = true;
              adapter.pendingToolCalls.get(sessionId)?.delete(toolCallId);
              continue;
            }
            if (dispatch) {
              dispatch.done = true;
              dispatch.info = { ...dispatch.info, status: b.is_error ? 'failed' : dispatch.info.status === 'running' ? 'completed' : dispatch.info.status };
            }
            adapter.onToolComplete?.(sessionId, {
              ...adapter.lifecycleEvent(entry),
              toolName: tracked?.toolName ?? 'tool',
              result,
              toolCallId,
              success: !b.is_error,
              ...(tracked?.parentToolCallId && { parentToolCallId: tracked.parentToolCallId }),
              ...(dispatch && { subagent: dispatch.info }),
              ...(imageAttachments.length > 0 && { attachments: imageAttachments }),
            });

            adapter.pendingToolCalls.get(sessionId)?.delete(toolCallId);
          }
        }
      }
      break;
    }

    default:
      // Ignore other message types (status, auth_status, etc.)
      break;
  }
}
