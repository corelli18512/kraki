/** Pi RPC events → Kraki: messages, deltas, tools, permissions, questions, compaction, subagents, turn end (handleEvent). */

import { PI_SUBAGENT_TOOL } from './pi-subagent.js';
import { readFileSync } from 'node:fs';
import { REPORT_MAX_BYTES } from '../report-policy.js';
import { fitToMaxDimension } from '../image-resize.js';
import { isKrakiSelfManagementCommand, SELF_MANAGEMENT_DENIAL_REASON, shellCommandFromInput } from '../self-management-guard.js';
import type { PiAdapter } from './pi.js';
import { shouldAutoApprove, parsePiPermission } from './pi-permissions.js';
import { KRAKI_DIALOG_PREFIX } from './pi-kraki-tools.js';
import { DELEGATE_ANSWER } from './permission-policy.js';
import { LEGACY_SHOW_HTML_MAX_BYTES, logger, type AssistantStreamEvent } from './pi-session.js';

/** Choices of a question card shown for another extension's confirm dialog. */
export const PI_CONFIRM_CHOICES = ['Yes', 'No'] as const;

/** The value Kraki's ask_user decodes (text plus optional images). */
export function krakiAnswerEnvelope(text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>): string {
  return JSON.stringify({ __krakiAnswer: 1, text, ...(images && images.length > 0 && { images }) });
}

// ── Event mapping: pi session.subscribe → Kraki callbacks ──
export async function handleEvent(adapter: PiAdapter, sessionId: string, e: { type: string; [k: string]: unknown }): Promise<void> {
  adapter.touch(sessionId);
  switch (e.type) {
    case 'compaction_start': {
      const reason = adapter.normalizeCompactionReason(e.reason);
      adapter.setCompacting(sessionId, true, { reason });
      const s = adapter.sessions.get(sessionId);
      // The start event closes the tiny ordering gap between the final
      // provider answer and background maintenance. Publish compaction first,
      // then settle the conversational turn while maintenance remains active.
      if (s && s.pendingMaintenanceIdle && (reason === 'threshold' || reason === 'overflow')) {
        s.pendingMaintenanceIdle = false;
        adapter.settleConversationalTurnAtAgentEnd(sessionId, s, false);
      }
      break;
    }
    case 'compaction_end':
      adapter.setCompacting(sessionId, false, {
        reason: adapter.normalizeCompactionReason(e.reason),
        aborted: e.aborted === true,
        willRetry: e.willRetry === true,
        errorMessage: typeof e.errorMessage === 'string' ? e.errorMessage : undefined,
      });
      break;
    case 'agent_start': {
      const s = adapter.sessions.get(sessionId);
      // A run while held: pi woke the agent with background results; it
      // continues the same Kraki turn.
      if (s?.awaitingSubagents) adapter.stopAwaitingSubagents(s, 'wake_run');
      if (s) {
        s.turn.captureTurnId();
        s.promptPreflight = undefined;
        s.pendingMaintenanceIdle = false;
      }
      // Streaming proves any preceding compaction is over even if its end
      // event was missed during resume/reconciliation.
      adapter.setCompacting(sessionId, false);
      break;
    }
    case 'message_update': {
      // Real model/tool activity also proves a stale compaction indicator is
      // no longer current. Clear only the adapter-owned compaction lifecycle;
      // CardManager independently protects newer action-slot owners.
      adapter.setCompacting(sessionId, false);
      const s = adapter.sessions.get(sessionId);
      const am = (e as { assistantMessageEvent?: AssistantStreamEvent }).assistantMessageEvent;
      if (am?.type === 'text_delta' && typeof am.delta === 'string') {
        adapter.onMessageDelta?.(sessionId, { content: am.delta, ...adapter.lifecycleEvent(s) });
      }
      break;
    }
    case 'message_end': {
      const m = (e as { message?: { role?: string; content?: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string } }).message;
      if (m?.role === 'custom') {
        // pi-subagents background run notifications.
        const custom = m as unknown as { customType?: string; content?: unknown };
        const text = typeof custom.content === 'string' ? custom.content : Array.isArray(custom.content) ? custom.content.map((c: { text?: string }) => c.text ?? '').join('\n') : '';
        const tracker = adapter.subagentTrackers.get(sessionId);
        const s = adapter.sessions.get(sessionId);
        if (tracker && custom.customType === 'subagent-notify') adapter.emitSubagentSteps(sessionId, s, tracker.onAsyncNotify(text));
        if (tracker && custom.customType === 'subagent-incremental-child-notify') adapter.emitSubagentSteps(sessionId, s, tracker.onChildNotify(text));
        if (s) adapter.checkSubagentsDone(sessionId, s);
      }
      if (m?.role === 'assistant') {
        const s = adapter.sessions.get(sessionId);
        // A backend failure (bad model, 400, quota, rate-limit) surfaces here
        // as stopReason:'error' with an empty content[] and an errorMessage.
        // Hold it until agent_end says whether Pi will retry; a later successful
        // message_end supersedes this provisional failure.
        if (s) {
          s.lastStopReason = m.stopReason;
          if (m.stopReason === 'error') {
            // A failure without an errorMessage is still a failure: keep a
            // non-empty message so it is reported instead of ending as a
            // silent reply-less turn.
            s.turn.setError(m.errorMessage?.trim()
              || 'The model request failed without an error message. Try sending again.');
          } else {
            s.turn.clearError();
          }
        }
        const prose = (m.content ?? [])
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('')
          .trim();
        // A finished prose segment: it reconciles the live draft now and
        // becomes a step only once a newer segment or a tool follows; the
        // last one is the reply (see TurnTracker).
        if (m.stopReason !== 'error' && prose && s) s.turn.proseSegment(prose);
        void adapter.refreshUsage(sessionId);
      }
      break;
    }
    case 'tool_execution_start': {
      adapter.setCompacting(sessionId, false);
      const toolName = String(e.toolName ?? 'tool');
      // ask_user surfaces via extension_ui_request (→ question card), not as a
      // TRACE step — swallow its tool_* so it doesn't leak into the trace.
      if (toolName === 'ask_user') break;
      // A real tool ran — the current narration (if any) is no longer the
      // trailing reply.
      // The pending narration is now confirmed intermediate (a tool follows it),
      // so FLUSH it to the trace BEFORE the tool step to keep chronological order.
      const s = adapter.sessions.get(sessionId);
      s?.turn.toolStarted();
      const subagent = toolName === PI_SUBAGENT_TOOL && typeof e.toolCallId === 'string'
        ? adapter.subagentTracker(sessionId).onStart(e.toolCallId, (e.args as Record<string, unknown>) ?? {})
        : undefined;
      adapter.onToolStart?.(sessionId, {
        ...adapter.lifecycleEvent(s),
        toolName,
        args: (e.args as Record<string, unknown>) ?? {},
        toolCallId: e.toolCallId as string | undefined,
        ...(subagent && { subagent }),
      });
      break;
    }
    case 'tool_execution_update': {
      if (e.toolName !== PI_SUBAGENT_TOOL || typeof e.toolCallId !== 'string') break;
      const emits = adapter.subagentTrackers.get(sessionId)?.onUpdate(e.toolCallId, e.partialResult) ?? [];
      adapter.emitSubagentSteps(sessionId, adapter.sessions.get(sessionId), emits);
      break;
    }
    case 'tool_execution_end': {
      const toolName = String(e.toolName ?? 'tool');
      // ask_user is a human-interaction tool, not TRACE.
      if (toolName === 'ask_user') break;
      // pi tool results are `{ content: [TextContent|ImageContent], details }`.
      // Extract text for the trace and externalize any image blocks (e.g. from
      // the show_image tool) into the attachment store so their bytes reach
      // connected devices — mirrors the claude/copilot outbound image path.
      const outputAttachments: import('@kraki/protocol').Attachment[] = [];
      let resultText: string;
      const raw = e.result as unknown;
      const blocks =
        raw && typeof raw === 'object' && Array.isArray((raw as { content?: unknown }).content)
          ? ((raw as { content: Array<Record<string, unknown>> }).content)
          : null;
      if (blocks) {
        resultText = blocks
          .filter(c => c.type === 'text' && typeof c.text === 'string')
          .map(c => c.text as string)
          .join('\n');
        if (adapter.attachmentStore) {
          for (const c of blocks) {
            if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string') {
              try {
                const bytes = Buffer.from(c.data, 'base64');
                const mime = c.mimeType;
                const { bytes: resized, mimeType: outMime } = await fitToMaxDimension(bytes, mime).catch(() => ({ bytes, mimeType: mime }));
                outputAttachments.push(adapter.attachmentStore.put(sessionId, resized, outMime, {}));
              } catch (err) {
                logger.warn({ err, sessionId }, 'failed to store pi image attachment');
              }
            }
          }
        }
      } else {
        resultText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      }
      const details = raw && typeof raw === 'object' && (raw as { details?: unknown }).details;
      if ((toolName === 'show_report' || toolName === 'show_html') && adapter.attachmentStore && details && typeof details === 'object') {
        const htmlPath = (details as { htmlPath?: unknown }).htmlPath;
        const lowerHtmlPath = typeof htmlPath === 'string' ? htmlPath.toLowerCase() : '';
        if (typeof htmlPath === 'string' && (lowerHtmlPath.endsWith('.html') || lowerHtmlPath.endsWith('.htm'))) {
          try {
            const html = readFileSync(htmlPath);
            const title = typeof (details as { title?: unknown }).title === 'string' ? (details as { title: string }).title : undefined;
            const name = typeof (details as { name?: unknown }).name === 'string' ? (details as { name: string }).name : 'report.html';
            // show_report validates its own 1 MB policy before returning; a Pi
            // session started before the rename still has show_html, whose
            // original 10 MB safety cap stays until that session restarts.
            if (html.length <= (toolName === 'show_html' ? LEGACY_SHOW_HTML_MAX_BYTES : REPORT_MAX_BYTES)) {
              outputAttachments.push(adapter.attachmentStore.put(sessionId, html, 'text/html', { name, caption: title }));
            }
          } catch (err) {
            logger.warn({ err, sessionId }, 'failed to store pi HTML artifact');
          }
        }
      }
      if (outputAttachments.length > 0 && !resultText) resultText = 'Output is ready.';
      let subagent: import('@kraki/protocol').SubagentInfo | undefined;
      if (toolName === PI_SUBAGENT_TOOL && typeof e.toolCallId === 'string') {
        const tracker = adapter.subagentTrackers.get(sessionId);
        const end = tracker?.onEnd(e.toolCallId, raw, e.isError === true);
        if (end) {
          adapter.emitSubagentSteps(sessionId, adapter.sessions.get(sessionId), end.emits);
          // A background launch: the step stays running until the run reports.
          if (end.async) break;
          subagent = end.subagent;
        }
      }
      adapter.onToolComplete?.(sessionId, {
        ...adapter.lifecycleEvent(adapter.sessions.get(sessionId)),
        toolName,
        result: resultText,
        toolCallId: e.toolCallId as string | undefined,
        success: e.isError !== true,
        ...(subagent && { subagent }),
        ...(outputAttachments.length > 0 && { attachments: outputAttachments }),
      });
      break;
    }
    case 'turn_end':
      // One agentic run = many turns (one per LLM round). Refresh usage but
      // DON'T signal idle here, so the arm groups all rounds (text + tools)
      // into a single turn. Idle is only the run boundary (agent_end).
      void adapter.refreshUsage(sessionId);
      break;
    case 'agent_end': {
      void adapter.refreshUsage(sessionId);
      logger.info({
        sessionId,
        turnId: adapter.sessions.get(sessionId)?.turn.event().turnId,
        phase: 'agent_end',
        attempt: typeof e.attempt === 'number' ? e.attempt : undefined,
        willRetry: e.willRetry === true,
      }, 'pi agent lifecycle');
      const s = adapter.sessions.get(sessionId);
      // Pi emits willRetry=false before non-retry threshold/overflow
      // compaction. Remember that the conversational answer may settle at
      // compaction_start; keep agent_settled as the fully-drained runtime
      // boundary when no maintenance event follows.
      if (s && e.willRetry === false) {
        s.pendingMaintenanceIdle = true;
      }
      break;
    }
    case 'agent_settled': {
      void adapter.refreshUsage(sessionId);
      logger.info({
        sessionId,
        turnId: adapter.sessions.get(sessionId)?.turn.event().turnId,
        phase: 'agent_settled',
        attempt: typeof e.attempt === 'number' ? e.attempt : undefined,
        willRetry: false,
      }, 'pi agent lifecycle');
      const s = adapter.sessions.get(sessionId);
      if (!s) {
        adapter.onIdle?.(sessionId);
        break;
      }
      s.pendingMaintenanceIdle = false;
      // A duplicate settled callback must not crystallize the same logical turn
      // twice. The identity is reset only when a new prompt is accepted.
      if (s.turn.isSettled) break;
      if (s.aborting) {
        // abortSession owns the terminal idle(reason=aborted) notification.
        s.turn.discardProse();
        break;
      }
      // Resolve a provisional backend failure only at this authoritative run
      // boundary. Recoverable attempts were suppressed by willRetry above.
      if (s.lastStopReason === 'error' || s.lastStopReason === 'aborted') {
        s.turn.discardProse();
        if (s.lastStopReason !== 'error') s.turn.clearError();
        s.turn.finish(); // the held error, if any, then idle
        break;
      }
      if (adapter.holdForSubagents(sessionId, s)) break;
      // The last prose with no tool after it is the reply; a run that ended
      // on a tool is just its Steps. Kraki relays that as-is: no extra model
      // call and nothing injected into the user's pi session. (A closing
      // summary, if wanted, belongs in the user's own pi configuration.)
      s.turn.finish();
      break;
    }
    case 'session_shutdown':
      adapter.onSessionEnded?.(sessionId, { reason: 'pi shutdown' });
      break;
    case 'extension_ui_request': {
      if (typeof e.id !== 'string') break;
      const s = adapter.sessions.get(sessionId);
      if (!s) break;
      // pi-subagents' documented RPC-host status feed for background runs.
      if (e.method === 'setWidget' && e.widgetKey === 'subagent-async') {
        const line = Array.isArray(e.widgetLines) ? String(e.widgetLines[0] ?? '') : '';
        const prefix = 'PI_SUBAGENT_ASYNC_JSON:';
        const tracker = adapter.subagentTrackers.get(sessionId);
        // pi-subagents repaints this widget every second while a run is listed
        // (only `generatedAt` changes). Only a changed run list is progress.
        let progressed = true;
        if (tracker && line.startsWith(prefix)) {
          try {
            const snapshot = JSON.parse(line.slice(prefix.length)) as { runs?: unknown };
            const key = JSON.stringify(snapshot?.runs ?? null);
            progressed = key !== s.subagentSnapshotKey;
            s.subagentSnapshotKey = key;
            adapter.emitSubagentSteps(sessionId, s, tracker.onAsyncSnapshot(snapshot));
          } catch (err) {
            logger.debug({ sessionId, err: (err as Error).message }, 'pi: unreadable subagent status snapshot');
          }
        } else if (tracker && !line) {
          // The widget is cleared once no background run remains.
          s.subagentSnapshotKey = undefined;
          adapter.emitSubagentSteps(sessionId, s, tracker.onAsyncSnapshot({ runs: [] }));
        }
        adapter.checkSubagentsDone(sessionId, s, progressed);
        break;
      }
      const rawTitle = typeof e.title === 'string' ? e.title : '';
      const ownDialog = rawTitle.startsWith(KRAKI_DIALOG_PREFIX);
      const title = ownDialog ? rawTitle.slice(KRAKI_DIALOG_PREFIX.length) : rawTitle;
      // Another extension's dialog: a plain question card answered with a plain
      // value — never Kraki's answer envelope or tool-permission policy.
      if (!ownDialog && (e.method === 'select' || e.method === 'input' || e.method === 'editor' || e.method === 'confirm')) {
        const qid = e.id;
        s.pendingQuestions.set(qid, qid);
        (s.foreignDialogs ??= new Map()).set(qid, e.method);
        const message = e.method === 'confirm' && typeof e.message === 'string' && e.message ? `\n\n${e.message}` : '';
        const choices = e.method === 'confirm'
          ? [...PI_CONFIRM_CHOICES]
          : e.method === 'select' && Array.isArray(e.options) ? (e.options as string[]) : undefined;
        adapter.onQuestionRequest?.(sessionId, {
          ...adapter.lifecycleEvent(s),
          id: qid,
          question: `${title || 'An extension has a question'}${message}`,
          choices,
        });
        break;
      }
      // ask_user surfaces via ctx.ui.select (choices) / ctx.ui.input (free-form)
      // → a Kraki question card. The arm's answer returns via respondToQuestion
      // → the matching extension_ui_response.
      if (e.method === 'select' || e.method === 'input') {
        const qid = e.id;
        if (s.mode === 'delegate') {
          // Delegate: the agent's own questions are auto-answered.
          s.proc.sendRaw({ type: 'extension_ui_response', id: qid, value: krakiAnswerEnvelope(DELEGATE_ANSWER) });
          logger.debug({ sessionId }, 'pi question auto-answered (delegate mode)');
          break;
        }
        s.pendingQuestions.set(qid, qid);
        const choices = Array.isArray(e.options) ? (e.options as string[]) : undefined;
        adapter.onQuestionRequest?.(sessionId, {
          ...adapter.lifecycleEvent(s),
          id: qid,
          question: title || 'The agent has a question',
          choices,
        });
        break;
      }
      // The permission-gate extension asks ctx.ui.confirm(toolName, inputJson)
      // before every non-capability tool → the adapter applies its mode policy:
      // auto-approve silently (no card) OR raise a Kraki permission card whose
      // decision returns via respondToPermission → extension_ui_response. Other
      // UI methods (notify/status/…) are unused and need no reply.
      if (e.method !== 'confirm') break;
      const permId = e.id;
      const toolName = title || 'tool';
      const inputJson = typeof e.message === 'string' ? e.message : '';
      let input: Record<string, unknown> = {};
      try {
        const parsed = inputJson ? JSON.parse(inputJson) : {};
        if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
      } catch { /* leave input empty on malformed JSON */ }
      if (toolName === 'bash' && isKrakiSelfManagementCommand(shellCommandFromInput(input))) {
        s.proc.sendRaw({
          type: 'extension_ui_response',
          id: permId,
          confirmed: false,
          error: SELF_MANAGEMENT_DENIAL_REASON,
        });
        logger.warn({ sessionId }, 'blocked tentacle self-management command');
        break;
      }
      if (shouldAutoApprove(s.mode, toolName, input)) {
        // Silent approve — no card. Respond immediately so the tool runs.
        s.proc.sendRaw({ type: 'extension_ui_response', id: permId, confirmed: true });
        logger.debug({ sessionId, toolName, mode: s.mode }, 'pi tool auto-approved');
        break;
      }
      s.pendingPerms.set(permId, permId);
      const { toolArgs, description } = parsePiPermission(toolName, inputJson);
      logger.debug({ sessionId, permId, toolName: toolArgs.toolName }, 'pi permission requested');
      adapter.onPermissionRequest?.(sessionId, { ...adapter.lifecycleEvent(s), id: permId, toolArgs, description });
      break;
    }
    default:
      break;
  }
}
