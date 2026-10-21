/** Session commands: create, fork, import local sessions, delete, archive, auto-titles. */

import { toWireSessionMode } from '@kraki/protocol';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProducerMessage, ConsumerMessage } from '@kraki/protocol';
import { scanLocalSessions, filterSessions } from '../session-scanner.js';
import { parseSessionHistory } from '../history-parser.js';
import { EventsWatcher } from '../events-watcher.js';
import { RelayClient } from '../relay-client.js';
import { beginAdapterTurn, finishTurnWithStatus, purgeSessionToolState, sendTurnIdle } from './turns.js';
import { logger, AUTO_ARCHIVE_SWEEP_MS } from './shared.js';

export async function handleCreateSession(client: RelayClient, msg: ConsumerMessage): Promise<void> {
  if (msg.type !== 'create_session') return;
  const { model, reasoningEffort, contextTier, cwd, prompt, requestId, agentId } = msg.payload;

  // Pre-generate a stable sessionId and map requestId BEFORE calling the adapter.
  // This is concurrency-safe: each request gets its own unique key.
  const preSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  if (requestId) {
    client.pendingRequestIds.set(preSessionId, requestId);
  }

  try {
    // Without an explicit folder the agent works in the user's home, never
    // the filesystem root.
    const result = await client.adapter.createSession({ model, reasoningEffort, contextTier, cwd: cwd || homedir(), sessionId: preSessionId, agentId });

    // If an initial prompt was provided, send it to the new session.
    // Otherwise mark idle — the SDK only fires session.idle after a turn
    // completes, so without a prompt the session would stay 'active' forever.
    if (prompt && result.sessionId) {
      beginAdapterTurn(client, result.sessionId);
      await client.adapter.sendMessage(result.sessionId, prompt);
    } else if (result.sessionId) {
      client.sessionManager.markIdle(result.sessionId);
      client.send({ type: 'idle', sessionId: result.sessionId, payload: {} });
    }
  } catch (err) {
    client.pendingRequestIds.delete(preSessionId);
    const errorMsg = `Couldn't create the session: ${(err as Error).message}`;
    logger.warn({ err, agentId, model }, 'create_session failed');
    client.send({
      type: 'error',
      sessionId: '',
      payload: { message: errorMsg, ...(requestId && { requestId }) },
    });
  }
}

export async function handleForkSession(client: RelayClient, msg: ConsumerMessage): Promise<void> {
  if (msg.type !== 'fork_session') return;
  const { sourceSessionId, requestId } = msg.payload;
  const started = Date.now();
  let newId: string | undefined;

  try {
    // 1. Kraki's own copy (meta, spine, trace; attachments link later).
    const result = client.sessionManager.forkSession(sourceSessionId);
    if (!result) throw new Error(`Source session not found: ${sourceSessionId}`);
    newId = result.sessionId;
    client.forkingSessions.add(newId);

    // 2. The agent's copy (transcript or thread), resumed lazily.
    await client.adapter.forkSession(sourceSessionId, newId);
    const meta = client.sessionManager.getMeta(newId);
    if (meta?.mode) client.adapter.setSessionMode(newId, meta.mode);
    client.forkingSessions.delete(newId);

    // 3. Announce the fork. The session list goes first: every app then
    // already knows the fork's name, state and preview when
    // session_created arrives (the requester navigates on it). The
    // announcement is not a spine row (seq 0): the fork's history ends
    // where the source's did.
    client.sessionManager.markIdle(newId);
    client.broadcastSessionList();
    client.send({
      type: 'session_created',
      sessionId: newId,
      payload: {
        agent: meta?.agent,
        model: meta?.model,
        reasoningEffort: meta?.reasoningEffort,
        requestId,
        lastSeq: meta?.lastSeq ?? 0,
        ...(meta?.mode && { mode: toWireSessionMode(meta.mode) }),
      },
    } as Partial<ProducerMessage>, false, { persist: false });

    // 4. Copied mid-turn: the copy's turn will never finish. Say so instead
    // of leaving a question that looks like it is still being answered.
    if (result.sourceWasRunning) closeForkedOpenTurn(client, newId);

    // Again after: older apps reset a session to "running, untitled" on
    // session_created; this restores it.
    client.broadcastSessionList();
    logger.info({ sourceSessionId, newId, ms: Date.now() - started }, 'Session forked');
  } catch (err) {
    if (newId) {
      client.forkingSessions.delete(newId);
      // Never leave a half-made copy behind (it showed as a session that
      // spun forever).
      purgeSessionToolState(client, newId);
      client.sessionManager.deleteSession(newId);
    }
    logger.error({ err, sourceSessionId }, 'Fork session failed');
    client.send({
      type: 'error',
      sessionId: '',
      payload: { message: `Couldn't copy the session: ${(err as Error).message}`, ...(requestId && { requestId }) },
    });
  }
}

/** Close the turn a fork copied while it was running. */
export function closeForkedOpenTurn(client: RelayClient, sessionId: string): void {
  // Shown like a turn the user stopped ("Stopped"): the copy simply ends
  // here; nothing failed.
  finishTurnWithStatus(client, sessionId, {
    type: 'user_abort',
    payload: { abortedAt: new Date().toISOString() },
  });
  sendTurnIdle(client, sessionId, {}, null);
  // The note is about the copy itself, not news for the user.
  const lastSeq = client.sessionManager.getMeta(sessionId)?.lastSeq;
  if (lastSeq) client.sessionManager.markRead(sessionId, lastSeq);
}

export function handleRequestLocalSessions(client: RelayClient, msg: ConsumerMessage): void {
  if (msg.type !== 'request_local_sessions') return;

  const { requestId, filter } = msg.payload;
  const requesterDeviceId = msg.deviceId;
  const requesterKey = client.consumerKeys.get(requesterDeviceId);

  try {
    let sessions = scanLocalSessions();
    const linkedIds = client.sessionManager.getLinkedIds();

    // Mark sessions that are already linked
    for (const s of sessions) {
      const link = client.sessionManager.getLink(s.sessionId);
      if (link) s.linkedKrakiSessionId = link.krakiSessionId;
    }

    // Exclude sessions that Kraki manages (natively created or imported)
    const krakiSessionIds = new Set(client.sessionManager.getSessionList({ all: true }).map(s => s.id));
    sessions = sessions.filter(s => !krakiSessionIds.has(s.sessionId) || s.linkedKrakiSessionId);

    // Apply filters
    if (filter) {
      sessions = filterSessions(sessions, filter, linkedIds);
    }

    const response = {
      type: 'local_sessions_list',
      deviceId: client.authInfo?.deviceId ?? '',
      seq: ++client.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { sessions, requestId },
    };

    if (requesterKey) {
      client.sendReliableUnicastTo(requesterDeviceId, requesterKey, response);
    } else {
      // No encryption key — broadcast (works in open/non-E2E mode)
      client.send(response as Partial<ProducerMessage>);
    }

    logger.debug({ count: sessions.length, requestId }, 'Sent local sessions list');
  } catch (err) {
    logger.error({ err }, 'Failed to scan local sessions');
    const response = {
      type: 'local_sessions_list',
      deviceId: client.authInfo?.deviceId ?? '',
      seq: ++client.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { sessions: [], requestId },
    };

    if (requesterKey) {
      client.sendReliableUnicastTo(requesterDeviceId, requesterKey, response);
    } else {
      client.send(response as Partial<ProducerMessage>);
    }
  }
}

export async function handleImportSession(client: RelayClient, msg: ConsumerMessage): Promise<void> {
  if (msg.type !== 'import_session') return;

  const { requestId, localSessionId, meta: clientMeta } = msg.payload as {
    requestId: string;
    localSessionId: string;
    meta?: { cwd?: string; summary?: string; source?: string; model?: string; branch?: string; startTime?: string };
  };

  // Check if already linked
  const existing = client.sessionManager.getLink(localSessionId);
  if (existing) {
    client.send({
      type: 'error',
      sessionId: '',
      payload: { message: `Session already imported as ${existing.krakiSessionId}`, ...(requestId && { requestId }) },
    });
    return;
  }

  try {
    const krakiSessionId = localSessionId;

    // ── Phase 1: Prepare locally (~85ms) ──────────────────
    // Parse events.jsonl for backfill + metadata
    const sessionStateDir = join(homedir(), '.copilot', 'session-state', localSessionId);
    const { messages: backfilledMessages, meta: parsedMeta } = parseSessionHistory(sessionStateDir);

    // Use metadata from the client (picker already has it) or parsed fallback
    const source: import('@kraki/protocol').LocalSessionSource = clientMeta?.source as import('@kraki/protocol').LocalSessionSource ?? 'copilot-cli';
    const model = parsedMeta.model ?? clientMeta?.model;
    const autoTitle = clientMeta?.summary?.slice(0, 100);
    const cwd = clientMeta?.cwd ?? parsedMeta.cwd ?? homedir();

    // Create Kraki session
    client.sessionManager.createSession('copilot', model, krakiSessionId);

    // Persist metadata
    client.sessionManager.updateMeta(krakiSessionId, {
      source,
      autoTitle,
      model,
      createdAt: clientMeta?.startTime,
    });

    // Batch-write the backfilled spine (single write instead of N appends),
    // in the same envelope shape send() persists. Tool activity is not on
    // the spine (it would take seqs that every reader then skips).
    const deviceId = client.authInfo?.deviceId ?? '';
    const spineRows = backfilledMessages
      .filter((m) => RelayClient.PERSISTENT_TYPES.has(m.type))
      .map((m) => ({
        type: m.type,
        ts: m.ts,
        payload: JSON.stringify({
          type: m.type, sessionId: krakiSessionId, deviceId, timestamp: m.ts, payload: JSON.parse(m.payload),
        }),
      }));
    const lastSeq = client.sessionManager.appendMessagesBatch(krakiSessionId, spineRows, true);

    // Write link table entry
    client.sessionManager.addLink({
      localSessionId,
      krakiSessionId,
      source,
      cwd,
      branch: clientMeta?.branch,
      linkedAt: new Date().toISOString(),
    });

    // ── Phase 2: Resume adapter (blocking) ────────────────
    // Clear the requestId so onSessionCreated doesn't send a duplicate session_created
    if (requestId) client.pendingRequestIds.delete(krakiSessionId);

    let adapterFailed = false;
    try {
      // An imported Copilot CLI session belongs to the Copilot agent, whatever
      // agent happens to be registered first (no Copilot → read-only import).
      await client.adapter.createSession({ sessionId: krakiSessionId, model: parsedMeta.model, cwd, agentId: 'copilot' });
    } catch (err) {
      adapterFailed = true;
      logger.warn({ err: (err as Error).message, krakiSessionId }, 'SDK resume failed — session imported as read-only');
    }

    // ── Phase 3: Broadcast to arms ────────────────────────
    // session_created = session is fully ready (or at least browsable)
    client.send({
      type: 'session_created',
      sessionId: krakiSessionId,
      payload: { agent: 'copilot', model, requestId, lastSeq },
    });

    // Send title
    if (autoTitle) {
      client.send({
        type: 'session_title_updated',
        sessionId: krakiSessionId,
        payload: { autoTitle },
      });
    }

    // No history broadcast: apps fetch it with request_session_messages
    // when they open the session (the old session_replay_batch pushed up
    // to 500 messages to every app).

    // Notify user if adapter failed — session is browsable but not interactive
    if (adapterFailed) {
      client.send({
        type: 'error',
        sessionId: krakiSessionId,
        payload: { message: 'Session imported but could not connect to agent — history is browsable, but new messages will not work.' },
      });
    }

    // Mark idle + broadcast session list
    client.sessionManager.markIdle(krakiSessionId);
    client.send({ type: 'idle', sessionId: krakiSessionId, payload: {} });
    client.broadcastSessionList();

    logger.info({ localSessionId, krakiSessionId, backfilled: spineRows.length, adapterFailed }, 'Session imported');

    // Start watching events.jsonl for external changes (CLI, VS Code)
    client.eventsWatcher?.watch(krakiSessionId);

  } catch (err) {
    logger.error({ err, localSessionId }, 'Import session failed');
    client.send({
      type: 'error',
      sessionId: localSessionId,
      payload: { message: `Couldn't import the session: ${(err as Error).message}`, ...(requestId && { requestId }) },
    });
  }
}

export function initEventsWatcher(client: RelayClient): void {
  if (client.eventsWatcher) client.eventsWatcher.close();

  client.eventsWatcher = new EventsWatcher(
    (msg) => {
      // Broadcast external events to all arms; send() persists spine types
      // itself (appending here too wrote every external event twice).
      client.mirroringExternalEvent = true;
      try {
        client.send({
          ...msg,
          deviceId: client.authInfo?.deviceId ?? '',
        } as unknown as Partial<ProducerMessage>);
      } finally {
        client.mirroringExternalEvent = false;
      }
    },
    client.authInfo?.deviceId ?? '',
  );

  // Start watching all currently linked sessions
  for (const link of client.sessionManager.getAllLinks()) {
    client.eventsWatcher.watch(link.localSessionId);
  }
}

/** Delete a session's files, live state and agent process. */
export function deleteSessionEverywhere(client: RelayClient, sessionId: string): void {
  // Remove from local session state SYNCHRONOUSLY. The adapter's
  // killSession runs async and may take a while to talk to the
  // Copilot SDK; we don't want broadcastSessionList to see
  // the still-tracked session and broadcast it back to arms.
  client.sessionManager.removeLinkByKrakiId(sessionId);
  client.sessionManager.deleteSession(sessionId);
  client.lastAgentContent.delete(sessionId);
  client.pendingTerminalErrors.delete(sessionId);
  client.settledAdapterTurnIds.delete(sessionId);
  client.activeInputTurnIds.delete(sessionId);
  client.nextInputTurnAnchors.delete(sessionId);
  purgeSessionToolState(client, sessionId);
  client.send({ type: 'session_deleted', sessionId, payload: {} });
  client.eventsWatcher?.unwatch(sessionId);
  // The agent's last writes (transcript, sidecar) can land after the
  // first removal; remove again once the process is gone so no
  // half-session directory is left behind.
  client.adapter.killSession(sessionId)
    .catch((err) => logger.error({ err, sessionId }, 'killSession on delete failed'))
    .finally(() => client.sessionManager.deleteSession(sessionId));
}

/** Opening or writing to an archived session brings it back (F2). */
export function unarchiveOnUse(client: RelayClient, sessionId: string): void {
  if (client.sessionManager.setArchived(sessionId, false)) client.broadcastSessionList();
}

export function handleRequestArchivedSessions(client: RelayClient, requesterDeviceId: string, requestId?: string): void {
  const sessions = client.sessionManager.getSessionList({ archived: true });
  const response = {
    type: 'archived_session_list',
    deviceId: client.authInfo?.deviceId ?? '',
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: { sessions, ...(requestId && { requestId }) },
  };
  const requesterKey = client.consumerKeys.get(requesterDeviceId);
  if (requesterKey) client.sendReliableUnicastTo(requesterDeviceId, requesterKey, response);
  else client.send(response as Partial<ProducerMessage>);
}

/** Delete every archived session (Settings → Delete archived sessions). */
export function handleDeleteArchivedSessions(client: RelayClient): void {
  const ids = client.sessionManager.getSessionList({ archived: true }).map((s) => s.id);
  for (const id of ids) deleteSessionEverywhere(client, id);
  logger.info({ count: ids.length }, 'Deleted archived sessions');
  client.broadcastSessionList();
}

export function handleSetAutoArchiveDays(client: RelayClient, days: unknown): void {
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 3650) return;
  client.options.autoArchiveDays = days;
  try { client.options.saveAutoArchiveDays?.(days); } catch (err) { logger.warn({ err }, 'Could not save auto-archive setting'); }
  client.runAutoArchive();
  client.broadcastSessionList();
}

/** Called from the 5s stale-check tick; sweeps at most every 6 hours. */
export function maybeAutoArchive(client: RelayClient, now: number): void {
  if (now - client.lastAutoArchiveAt < AUTO_ARCHIVE_SWEEP_MS) return;
  client.lastAutoArchiveAt = now;
  try {
    if (client.runAutoArchive(now)) client.broadcastSessionList();
  } catch (err) {
    logger.warn({ err }, 'Auto-archive sweep failed');
  }
}

export function maybeGenerateTitle(client: RelayClient, sessionId: string): void {
  const meta = client.sessionManager.getMeta(sessionId);
  // The turn counter is in memory. After a daemon restart a session that
  // already has a title must not count from 1 again (that retitled it on
  // every restart): resume past the early refinements.
  const known = client.turnCounts.get(sessionId) ?? (meta?.autoTitle ? 5 : 0);
  const turns = known + 1;
  client.turnCounts.set(sessionId, turns);

  if (!meta) return;

  // Manual title set — skip auto-generation
  if (meta.title) return;

  // Schedule: turn 1, turn 5, then every 20 turns
  const shouldGenerate = turns === 1 || turns === 5
    || (turns > 5 && (turns - 5) % 20 === 0);

  logger.debug({ sessionId, turns, shouldGenerate }, 'maybeGenerateTitle check');

  if (!shouldGenerate) return;

  // One generation in flight per session
  if (client.titleGenerationInFlight.has(sessionId)) return;
  client.titleGenerationInFlight.add(sessionId);

  // Read only recent messages — full log is unnecessary for title context
  const lastSeq = meta.lastSeq ?? 0;
  const recentMsgs = client.sessionManager.getMessagesAfterSeq(sessionId, Math.max(0, lastSeq - 20));
  const userMessages: string[] = [];
  for (const m of recentMsgs) {
    try {
      const parsed = JSON.parse(m.payload);
      if (parsed.type === 'user_message' && parsed.payload?.content) {
        userMessages.push(parsed.payload.content);
      }
    } catch { /* skip */ }
  }

  const lastUserMessage = userMessages[userMessages.length - 1] ?? '';
  // For context: last 3 user messages, most recent first
  const recentMessages = userMessages.slice(-3).reverse();
  // Include current auto-title so the LLM can refine rather than regenerate
  const currentTitle = meta.autoTitle;

  // Message content never goes to the log (it ships in diagnostics bundles).
  logger.debug({ sessionId, turns, lastUserMessageChars: lastUserMessage.length, totalUserMsgs: userMessages.length }, 'Title generation starting');

  if (!lastUserMessage) {
    client.titleGenerationInFlight.delete(sessionId);
    return;
  }

  client.adapter.generateTitle(sessionId, {
    firstUserMessage: recentMessages[recentMessages.length - 1] ?? lastUserMessage,
    lastUserMessage,
    recentMessages,
    currentTitle,
    // Same agent + same model as the session: the only guaranteed-available pair.
    agent: meta.agent,
    model: meta.model,
    reasoningEffort: meta.reasoningEffort,
  })
    .then((title) => {
      if (title) {
        client.sessionManager.setAutoTitle(sessionId, title);
        client.send({
          type: 'session_title_updated',
          sessionId,
          payload: { title: client.sessionManager.getMeta(sessionId)?.title, autoTitle: title },
        });
        logger.info({ sessionId, title, turn: turns }, 'Auto-title generated');
      }
    })
    .catch((err) => {
      logger.warn({ err, sessionId }, 'Title generation failed');
    })
    .finally(() => {
      client.titleGenerationInFlight.delete(sessionId);
    });
}
