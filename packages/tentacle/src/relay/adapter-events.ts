/** Agent adapter callbacks → spine, live card and trace (wireAdapterEvents). */

import { DEFAULT_SESSION_MODE, toWireSessionMode } from '@kraki/protocol';
import { type SessionManager } from '../session-manager.js';
import { makeHeadline } from '../tool-headline.js';
import { RelayClient } from '../relay-client.js';
import { addOpenQuestion, removeOpenQuestion, soleOpenQuestion } from './questions.js';
import { handleCreateSession, handleImportSession } from './session-commands.js';
import { ensureSessionResumed } from './session-resume.js';
import { acceptsAdapterEvent, acceptsAdapterTurn, clearCompacting, purgeSessionToolState, resolveTurnIdle, setCompacting, settleAdapterIdle } from './turns.js';
import { logger, normalizeTerminalErrorMessage } from './shared.js';

export function wireAdapterEvents(client: RelayClient): void {
  client.adapter.onSessionCreated = (event) => {
    if (client.forkingSessions.has(event.sessionId)) return;
    // Track in SessionManager if not already tracked (from resume)
    if (!client.sessionManager.getMeta(event.sessionId)) {
      client.sessionManager.createSession(
        event.agent,
        event.model,
        event.sessionId,
        event.reasoningEffort,
      );
    }
    // Look up requestId by sessionId (set in handleCreateSession before adapter call)
    const requestId = client.pendingRequestIds.get(event.sessionId);
    if (requestId) client.pendingRequestIds.delete(event.sessionId);

    // Skip duplicate broadcast for imported sessions — handleImportSession
    // already sent session_created and cleared the requestId.
    if (!requestId && client.sessionManager.getLink(event.sessionId)) {
      return;
    }

    const meta = client.sessionManager.getMeta(event.sessionId);
    client.send({
      type: 'session_created',
      sessionId: event.sessionId,
      payload: {
        agent: event.agent,
        model: event.model ?? meta?.model,
        reasoningEffort: event.reasoningEffort ?? meta?.reasoningEffort,
        requestId,
        lastSeq: meta?.lastSeq ?? 0,
        mode: toWireSessionMode(meta?.mode ?? DEFAULT_SESSION_MODE),
      },
    });
  };

  client.adapter.onMessage = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    // A genuine final reply is authoritative for the turn. Any provider error
    // broadcast before recovery must not be frozen as the outcome at idle.
    client.pendingTerminalErrors.delete(sessionId);
    // Clear the server-side draft state FIRST so a reconnect snapshot doesn't
    // re-seed a stale draft; arms clear the live draft in the SAME store update
    // that lands this permanent bubble (no double-render flash). onBubble does
    // NOT broadcast an empty reset (that clear-then-re-add was the flicker).
    client.card.onBubble(sessionId);
    client.send({
      type: 'agent_message',
      sessionId,
      payload: { content: event.content },
    });
    // Update context with latest state
    client.sessionManager.updateContext(sessionId, {
      lastUserMessage: '', // Will be set by send_input handler
    });
  };

  client.adapter.onMessageDelta = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    // Streaming narration/progress prose → the draft bubble (coalesced in
    // send()). Rendered as a clean in-flow spine bubble, kept-last per segment.
    client.card.onDelta(sessionId, event.content);
  };

  // Finalized narration prose. Two decoupled axes:
  //  • onNarration → LIVE card reconcile only (onNarrationFinal). Fires on
  //    EVERY finalized segment so the streamed draft is reconciled in place
  //    before the concluding bubble lands (no draft→spine size-jump).
  //  • onNarrationTrace → TRACE axis only: mirror to trace.jsonl for the lazy
  //    "Steps" history. Adapters fire this ONLY for segments that are genuine
  //    intermediate steps — never the trailing one that graduates into the
  //    bubble — so a reply never shows duplicated (last Step + bubble).
  client.adapter.onNarration = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    client.card.onNarrationFinal(sessionId, event.content);
  };
  client.adapter.onNarrationTrace = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    recordTrace(client, { type: 'agent_narration', sessionId, payload: { content: event.content, ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }) } });
  };

  client.adapter.onPermissionRequest = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    const action = {
      type: 'permission' as const,
      payload: { ...event.toolArgs, id: event.id, description: event.description },
    };
    client.card.onPrompt(sessionId, action);
    let permissions = client.openPermissions.get(sessionId);
    if (!permissions) {
      permissions = new Map();
      client.openPermissions.set(sessionId, permissions);
    }
    permissions.set(event.id, {
      text: event.description || event.toolArgs.toolName,
      openedAt: new Date().toISOString(),
    });
    client.broadcastSessionList();
    recordTrace(client, { type: 'permission', sessionId, payload: { ...action.payload, ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }) } });
  };

  // Auto-resolved (e.g. by an Always Allow rule) — mark the slot approved.
  client.adapter.onPermissionAutoResolved = (sessionId, permissionId) => {
    client.card.resolvePrompt(sessionId, permissionId, { decision: 'approve' });
    client.openPermissions.get(sessionId)?.delete(permissionId);
    client.broadcastSessionList();
    recordTrace(client, { type: 'permission', sessionId, payload: { id: permissionId, description: '', toolName: '', args: {}, decision: 'approve' } });
  };

  // Withdrawn by the agent (timeout/cancel): stop routing answers to it. On
  // the spine the question closes as unanswered once anything else follows.
  client.adapter.onQuestionAutoResolved = (sessionId, questionId) => {
    removeOpenQuestion(client, sessionId, questionId);
    client.broadcastSessionList();
  };

  // The question lands on the spine as an agent_message: its content is the
  // live draft (the agent's lead-in), taken atomically so the explanation and
  // the question can never be shown apart. It does not conclude the turn.
  client.adapter.onQuestionRequest = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    const lead = client.card.state(sessionId).draft;
    client.card.onBubble(sessionId);
    const message = {
      type: 'agent_message' as const,
      sessionId,
      payload: {
        content: lead,
        question: {
          id: event.id,
          text: event.question,
          ...(event.choices?.length ? { choices: event.choices } : {}),
        },
      },
    };
    // A question waiting on the human is an attention boundary (badge).
    client.send(message, true);
    const questionSeq = (message as typeof message & { seq?: number }).seq;
    addOpenQuestion(client, sessionId, {
      version: 2,
      kind: 'question',
      questionId: event.id,
      question: event.question,
      ...(event.choices?.length ? { choices: event.choices } : {}),
      ...(questionSeq ? { questionSeq } : {}),
      createdAt: new Date().toISOString(),
    });
    client.broadcastSessionList();
  };

  client.adapter.onToolStart = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    const headline = makeHeadline(event.toolName, event.args);
    const argsRef = offloadArgs(client, sessionId, event.toolName, event.args);
    // Ship args inline when below the offload floor so clients always have source data
    const inlineArgs = !argsRef && event.args ? event.args : undefined;
    if (event.toolCallId) {
      client.lastArgsByToolCallId.set(event.toolCallId, event.args ?? {});
      if (argsRef) client.lastArgsRefByToolCallId.set(event.toolCallId, argsRef);
      let inflight = client.sessionToolCallIds.get(sessionId);
      if (!inflight) {
        inflight = new Set();
        client.sessionToolCallIds.set(sessionId, inflight);
      }
      inflight.add(event.toolCallId);
    }
    const toolStartMsg = {
      type: 'tool_start',
      sessionId,
      payload: {
        toolName: event.toolName,
        headline,
        ...(argsRef && { argsRef }),
        ...(inlineArgs && { args: inlineArgs }),
        toolCallId: event.toolCallId,
        ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }),
        ...(event.subagent && { subagent: event.subagent }),
      },
    };
    // Off-spine: mirror to trace.jsonl for the lazy "Steps" history, and fold
    // into the card's action slot — no live standalone broadcast.
    recordTrace(client, toolStartMsg);
    client.card.onToolStart(sessionId, {
      type: 'tool_start',
      payload: {
        toolName: event.toolName,
        headline,
        ...(argsRef && { argsRef }),
        toolCallId: event.toolCallId,
        // Kept so a turn-end synthetic completion stays under its subagent.
        ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }),
        ...(event.subagent && { subagent: event.subagent }),
      },
    });
    // Track key files from tool usage
    if (/^(?:read_file|write_file|view|edit|create|read|write|multiedit|notebookedit)$/i.test(event.toolName)) {
      const toolArgs = (event.args ?? {}) as Record<string, unknown>;
      const path = (typeof toolArgs.path === 'string' ? toolArgs.path : typeof toolArgs.file_path === 'string' ? toolArgs.file_path : undefined);
      if (path) {
        const ctx = client.sessionManager.getContext(sessionId);
        if (ctx) {
          const files = new Set(ctx.keyFiles);
          files.add(path);
          client.sessionManager.updateContext(sessionId, { keyFiles: Array.from(files) });
        }
      }
    }
  };

  client.adapter.onToolComplete = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    // Recompute headline from the args we stashed at start; falls back to
    // toolName if args aren't available.
    const stashedArgs = client.lastArgsByToolCallId.get(event.toolCallId ?? '');
    const headline = makeHeadline(event.toolName, stashedArgs ?? {});
    const resultRef = offloadResult(client, sessionId, event.toolName, event.result);
    const argsRef = client.lastArgsRefByToolCallId.get(event.toolCallId ?? '');
    // Ship stashed args inline when below the offload floor
    const inlineArgs = !argsRef && stashedArgs && Object.keys(stashedArgs).length > 0 ? stashedArgs : undefined;
    if (event.toolCallId) {
      client.lastArgsByToolCallId.delete(event.toolCallId);
      client.lastArgsRefByToolCallId.delete(event.toolCallId);
      const inflight = client.sessionToolCallIds.get(sessionId);
      if (inflight) {
        inflight.delete(event.toolCallId);
        if (inflight.size === 0) client.sessionToolCallIds.delete(sessionId);
      }
    }
    const toolCompleteMsg = {
      type: 'tool_complete',
      sessionId,
      payload: {
        toolName: event.toolName,
        headline,
        ...(resultRef && { resultRef }),
        ...(argsRef && { argsRef }),
        ...(inlineArgs && { args: inlineArgs }),
        toolCallId: event.toolCallId,
        ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }),
        ...(event.subagent && { subagent: event.subagent }),
        ...(event.success === false && { success: false }),
        ...(event.attachments?.length && { attachments: event.attachments }),
      },
    };
    recordTrace(client, toolCompleteMsg);
    client.card.onToolComplete(sessionId, {
      type: 'tool_complete',
      payload: {
        toolName: event.toolName,
        headline,
        ...(resultRef && { resultRef }),
        ...(argsRef && { argsRef }),
        toolCallId: event.toolCallId,
        ...(event.success === false && { success: false }),
        ...(event.attachments?.length && { attachments: event.attachments }),
      },
    });
  };

  client.adapter.onIdle = (sessionId, event) => {
    if (!acceptsAdapterTurn(client, sessionId, event?.turnId)) return;
    if (client.steerAcceptanceInFlight.has(sessionId)) {
      client.idleDuringSteerAcceptance.add(sessionId);
      return;
    }
    settleAdapterIdle(client, sessionId, event);
  };

  client.adapter.onFlushComplete = (sessionId) => {
    client.eventsWatcher?.resume(sessionId);
  };

  client.adapter.onUsageUpdate = (sessionId, usage) => {
    client.sessionManager.setUsage(sessionId, usage);
  };

  client.adapter.onCompaction = (sessionId, event) => {
    // Compaction is maintenance, not a turn-scoped terminal callback. Its
    // end may arrive after a follow-up has opened a newer logical turn, so
    // retain the owner identity from start and fence against that identity
    // rather than against the current active turn.
    if (event.phase === 'start') {
      if (!acceptsAdapterTurn(client, sessionId, event.turnId)) return;
      if (!client.compactingSessions.has(sessionId)) {
        client.compactionTurnIds.set(sessionId, event.turnId);
      }
      setCompacting(client, sessionId, true, event.reason);
      return;
    }
    const ownerTurnId = client.compactionTurnIds.get(sessionId);
    if (event.turnId && ownerTurnId && event.turnId !== ownerTurnId) return;
    setCompacting(client, sessionId, false);
  };

  client.adapter.onError = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    const activeTurnId = event.turnId ?? client.activeInputTurnIds.get(sessionId) ?? '__unidentified__';

    // Stage as the terminal outcome so idle freezes it as a `failed` card,
    // AND broadcast the error immediately so apps surface it without waiting
    // for the turn to settle. Keep the best available text: concrete provider
    // failures outrank generic enum values, and invalid values use a safe
    // fallback rather than surfacing `success` or `unknown` as an error.
    const candidate = normalizeTerminalErrorMessage(event.message);
    const current = client.pendingTerminalErrors.get(sessionId);
    const currentForTurn = current?.turnId === activeTurnId ? current : undefined;
    const currentQuality = currentForTurn
      ? normalizeTerminalErrorMessage(currentForTurn.message).quality
      : -1;
    const selected = !currentForTurn || candidate.quality > currentQuality
      ? { message: candidate.message, source: 'backend' as const, turnId: activeTurnId }
      : currentForTurn;
    client.pendingTerminalErrors.set(sessionId, selected);
    recordTrace(client, {
      type: 'error',
      sessionId,
      payload: { message: candidate.message },
    });
    // `error` rows are permanent history. A turn that retries can report
    // many errors (and may still recover), so persist only the first one per
    // turn; the rest go to the Steps trace, and a turn that does fail shows
    // the best message on its failed card at idle.
    if (client.errorPersistedForTurn.get(sessionId) === activeTurnId) return;
    client.errorPersistedForTurn.set(sessionId, activeTurnId);
    client.send({
      type: 'error',
      sessionId,
      payload: { message: selected.message },
    });
  };

  // Kraki-originated spine notice (not the agent's words). Persisted like a
  // bubble so the turn — which produced no final reply — still has an
  // anchor for its "Steps" history.
  client.adapter.onSystemMessage = (sessionId, event) => {
    if (!acceptsAdapterEvent(client, sessionId, event.turnId)) return;
    client.card.onBubble(sessionId);
    client.send({
      type: 'system_message',
      sessionId,
      payload: { kind: event.kind, content: event.content },
    });
  };

  client.adapter.onSessionEnded = (sessionId, event) => {
    client.sessionManager.endSession(sessionId, event.reason);
    client.turnCounts.delete(sessionId);
    client.turnStepCounts.delete(sessionId);
    client.titleGenerationInFlight.delete(sessionId);
    client.lastAgentContent.delete(sessionId);
    client.pendingTerminalErrors.delete(sessionId);
    client.settledAdapterTurnIds.delete(sessionId);
    client.activeInputTurnIds.delete(sessionId);
    client.nextInputTurnAnchors.delete(sessionId);
    purgeSessionToolState(client, sessionId);
    client.steerAcceptanceInFlight.delete(sessionId);
    client.idleDuringSteerAcceptance.delete(sessionId);
    resolveTurnIdle(client, sessionId);
    clearCompacting(client, sessionId);
    client.card.delete(sessionId);
    client.send({
      type: 'session_ended',
      sessionId,
      payload: { reason: event.reason },
    });
  };

  // Idle-session eviction: keep meta state consistent with runtime load-
  // state by marking the session `disconnected` on eviction. No arm
  // broadcast — load-state is internal; the next user interaction goes
  // through ensureSessionResumed and lazy-loads transparently.
  //
  // Defensive fail-closed path: an adapter must never evict an active turn,
  // but process lifecycle bugs can violate that contract (for example, a long
  // retry backoff with no events being mistaken for idle). Terminalize every
  // accepted unsettled turn before disconnecting; this also resolves a normal
  // prompt waiter when present, but covers waiter-less steer/initial turns too.
  // Keep a sole open question recoverable: Pi deliberately retains that card
  // across process loss so its answer can become a lazy-resume recovery prompt.
  client.adapter.onSessionEvicted = (sessionId) => {
    client.sleepGuard.release(sessionId);
    const turnId = client.activeInputTurnIds.get(sessionId);
    const hasUnsettledAcceptedTurn = !!turnId
      && client.settledAdapterTurnIds.get(sessionId) !== turnId;
    const hasRecoverableQuestion = !!soleOpenQuestion(client, sessionId);
    if (hasUnsettledAcceptedTurn && !hasRecoverableQuestion) {
      client.pendingTerminalErrors.set(sessionId, {
        message: 'Agent process was evicted before the active turn settled.',
        code: 'process_lost',
        source: 'process',
        turnId,
      });
      settleAdapterIdle(client, sessionId, { turnId });
    }
    client.sessionManager.markDisconnected(sessionId);
    if (!hasRecoverableQuestion) client.card.delete(sessionId);
  };

  // SDK title fallback — use as fast placeholder while LLM generation runs
  client.adapter.onTitleChanged = (sessionId, title) => {
    const meta = client.sessionManager.getMeta(sessionId);
    if (!meta?.autoTitle) {
      client.sessionManager.setAutoTitle(sessionId, title);
      client.send({
        type: 'session_title_updated',
        sessionId,
        payload: { title: meta?.title, autoTitle: title },
      });
    }
  };
}

/** Build a ContentRef for the args JSON if the serialized size exceeds the
 *  inline floor. Returns undefined when args are trivially small. */
export function offloadArgs(
  client: RelayClient,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
): import('@kraki/protocol').ContentRef | undefined {
  if (!client.attachmentStore || !args) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (serialized.length < RelayClient.ARGS_INLINE_FLOOR) return undefined;
  try {
    const ref = client.attachmentStore.put(
      sessionId,
      Buffer.from(serialized, 'utf-8'),
      'application/json',
      { name: `${toolName}.args.json` },
    );
    return ref;
  } catch (err) {
    logger.warn({ err, sessionId, toolName }, 'failed to offload args');
    return undefined;
  }
}

/** Build a ContentRef for the tool result body. All non-empty results are
 *  offloaded (uniform lazy treatment — the wire shape stays predictable). */
export function offloadResult(
  client: RelayClient,
  sessionId: string,
  toolName: string,
  result: string | undefined,
): import('@kraki/protocol').ContentRef | undefined {
  if (!client.attachmentStore || !result) return undefined;
  try {
    const ref = client.attachmentStore.put(
      sessionId,
      Buffer.from(result, 'utf-8'),
      'text/plain',
      { name: `${toolName}.result.txt` },
    );
    return ref;
  } catch (err) {
    logger.warn({ err, sessionId, toolName }, 'failed to offload result');
    return undefined;
  }
}

/** Mirror an off-spine step (tool_start / tool_complete / agent_narration) to
 *  the session's `trace.jsonl` without broadcasting it live — the live view
 *  is served by the status card; this is only for the lazy "Steps" history. */
export function recordTrace(client: RelayClient, msg: { type: string; sessionId: string; payload: unknown }): void {
  client.sleepGuard.touch(msg.sessionId);
  // Per-turn step counter (chip-producing entries only — tool_complete merges
  // into its matching tool_start chip, so don't count it). The concluding
  // agent_message / system_message stamps this running total as payload.steps
  // (see send()), letting a concluded bubble show its "Steps" affordance from
  // replay alone — WITHOUT first pulling the transient trace.
  if (
    msg.type === 'tool_start' || msg.type === 'agent_narration' ||
    msg.type === 'permission' || msg.type === 'error'
  ) {
    client.turnStepCounts.set(msg.sessionId, (client.turnStepCounts.get(msg.sessionId) ?? 0) + 1);
  }
  const enriched = { ...msg, timestamp: new Date().toISOString() };
  client.sessionManager.appendTrace(msg.sessionId, msg.type, JSON.stringify(enriched));
}
