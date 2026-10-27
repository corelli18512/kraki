/** History requests: replay, message pages and ranges, turn traces, subscriptions, the live card. */

import type { SessionLiveSnapshot, SessionDigest } from '@kraki/protocol';
import { RelayClient } from '../relay-client.js';
import { logger } from './shared.js';

/**
 * Handle a per-session replay request from a reconnecting app.
 */
export function handleSessionReplay(client: RelayClient, requesterDeviceId: string, sessionId: string, afterSeq: number, limit?: number): void {
  const requesterKey = client.consumerKeys.get(requesterDeviceId);
  if (!requesterKey) {
    logger.warn({ requesterDeviceId }, 'Session replay requested but no encryption key for requester');
    return;
  }

  const logged = client.sessionManager.getMessagesAfterSeq(sessionId, afterSeq, limit);

  // Parse logged messages into ProducerMessage objects.
  // Filter out transient types that may exist in older logs — they don't
  // belong in the content stream and would create seq gaps on the arm.
  const parsed: Array<Record<string, unknown>> = [];
  for (const entry of logged) {
    if (!RelayClient.PERSISTENT_TYPES.has(entry.type)) continue;
    try {
      const msg = JSON.parse(entry.payload);
      msg.seq = entry.seq;
      parsed.push(msg);
    } catch {
      logger.warn({ seq: entry.seq, sessionId }, 'Failed to parse session message for batch');
    }
  }

  const replayedLastSeq = logged.length > 0 ? logged[logged.length - 1].seq : afterSeq;
  const meta = client.sessionManager.getMeta(sessionId);

  const batchMsg = {
    type: 'session_replay_batch',
    deviceId: client.authInfo?.deviceId ?? '',
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: {
      sessionId,
      messages: parsed,
      lastSeq: replayedLastSeq,
      totalLastSeq: meta?.lastSeq ?? replayedLastSeq,
    },
  };
  const bytes = client.sendReliableUnicastTo(requesterDeviceId, requesterKey, batchMsg);
  logger.info({ requesterDeviceId, sessionId, afterSeq, limit, count: logged.length, bytes, transport: client.transportTo(requesterDeviceId) }, 'Replaying session messages (batch)');
}

/**
 * Handle a turn-aware session messages request.
 */
export function handleSessionMessages(client: RelayClient, requesterDeviceId: string, sessionId: string, beforeSeq: number | undefined, afterSeq?: number): void {
  const requesterKey = client.consumerKeys.get(requesterDeviceId);
  if (!requesterKey) {
    logger.warn({ requesterDeviceId }, 'Session messages requested but no encryption key for requester');
    return;
  }

  const meta = client.sessionManager.getMeta(sessionId);
  if (!meta) {
    client.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
      type: 'session_messages_batch',
      deviceId: client.authInfo?.deviceId ?? '',
      seq: ++client.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { sessionId, messages: [], firstSeq: 0, lastSeq: 0, containsHead: true },
    });
    return;
  }

  const headSeq = meta.lastSeq ?? 0;
  const endSeqExclusive = beforeSeq ?? headSeq + 1;

  if (endSeqExclusive <= 1) {
    client.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
      type: 'session_messages_batch',
      deviceId: client.authInfo?.deviceId ?? '',
      seq: ++client.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { sessionId, messages: [], firstSeq: 1, lastSeq: 0, containsHead: endSeqExclusive > headSeq },
    });
    return;
  }

  let startSeq = client.sessionManager.findTurnAlignedStart(sessionId, endSeqExclusive);

  const HARD_CAP = 500;
  if (endSeqExclusive - startSeq > HARD_CAP) {
    startSeq = endSeqExclusive - HARD_CAP;
  }
  // A head request from a device that already has everything through
  // `afterSeq`: only what it is missing (a reconnect typically misses 1–2
  // messages, while the latest turn is ~100).
  const delta = beforeSeq === undefined && typeof afterSeq === 'number' && Number.isInteger(afterSeq)
    && afterSeq >= 0 && afterSeq + 1 > startSeq;
  if (delta) startSeq = Math.min(afterSeq + 1, endSeqExclusive);

  const endSeqInclusive = endSeqExclusive - 1;
  const logged = client.sessionManager
    .getMessagesAfterSeq(sessionId, startSeq - 1)
    .filter(e => e.seq <= endSeqInclusive);

  const parsed: Array<Record<string, unknown>> = [];
  for (const entry of logged) {
    if (!RelayClient.PERSISTENT_TYPES.has(entry.type)) continue;
    try {
      const msg = JSON.parse(entry.payload);
      msg.seq = entry.seq;
      parsed.push(msg);
    } catch {
      logger.warn({ seq: entry.seq, sessionId }, 'Failed to parse session message for turn-aware batch');
    }
  }

  const batchMsg = {
    type: 'session_messages_batch',
    deviceId: client.authInfo?.deviceId ?? '',
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: {
      sessionId,
      messages: parsed,
      firstSeq: parsed.length > 0 ? parsed[0].seq as number : startSeq,
      // Nothing new (or only seqs clients never store): report the head so
      // the requester counts itself caught up.
      lastSeq: parsed.length > 0 ? (parsed.at(-1) as Record<string, unknown>).seq as number
        : (delta ? endSeqInclusive : startSeq - 1),
      containsHead: endSeqInclusive >= headSeq,
    },
  };
  const bytes = client.sendReliableUnicastTo(requesterDeviceId, requesterKey, batchMsg);
  logger.info(
    { requesterDeviceId, sessionId, beforeSeq, afterSeq, startSeq, endSeqInclusive, count: parsed.length, bytes, transport: client.transportTo(requesterDeviceId) },
    'Replied to turn-aware session messages request',
  );
}

/**
 * Handle an exact seq-range messages request.
 *
 * Used for gap recovery (push delivered a seq jump and the arm wants
 * to fill the missing seqs) and for range queries (web's IndexedDB
 * cache filling holes). Distinct from `handleSessionMessages` —
 * range queries are NOT turn-aligned and return exactly the seqs
 * requested, subject to defensive clamping.
 *
 * Robustness contract:
 *  - `fromSeq < 1`     → clamped to 1
 *  - `toSeq > headSeq` → clamped to headSeq (informational, not lossy)
 *  - `fromSeq > toSeq` (post-clamp) → empty batch, truncated=false
 *  - range > `RANGE_MAX_COUNT` → keep newer end, `truncated: true`
 *    so caller can iterate for older seqs
 *  - session not found → empty batch, truncated=false
 */
export function handleSessionMessagesRange(
  client: RelayClient,
  requesterDeviceId: string,
  sessionId: string,
  fromSeq: number,
  toSeq: number,
): void {
  const requesterKey = client.consumerKeys.get(requesterDeviceId);
  if (!requesterKey) {
    logger.warn({ requesterDeviceId }, 'Session messages range requested but no encryption key for requester');
    return;
  }

  const sendEmpty = (): void => {
    client.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
      type: 'session_messages_range_batch',
      deviceId: client.authInfo?.deviceId ?? '',
      seq: ++client.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { sessionId, messages: [], firstSeq: 0, lastSeq: 0, truncated: false },
    });
  };

  const meta = client.sessionManager.getMeta(sessionId);
  if (!meta) {
    logger.info({ requesterDeviceId, sessionId, fromSeq, toSeq }, 'Range request for unknown session — empty reply');
    sendEmpty();
    return;
  }

  const headSeq = meta.lastSeq ?? 0;

  // Sanitize bounds — never trust client input.
  let lo = Math.max(1, Math.floor(fromSeq));
  let hi = Math.min(headSeq, Math.floor(toSeq));

  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
    logger.info({ requesterDeviceId, sessionId, fromSeq, toSeq, lo, hi, headSeq }, 'Range request empty after clamping');
    sendEmpty();
    return;
  }

  // Server-side hard cap — keep newer end so client can iterate older.
  let truncated = false;
  if (hi - lo + 1 > RelayClient.RANGE_MAX_COUNT) {
    lo = hi - RelayClient.RANGE_MAX_COUNT + 1;
    truncated = true;
  }

  const logged = client.sessionManager
    .getMessagesAfterSeq(sessionId, lo - 1)
    .filter(e => e.seq <= hi);

  const parsed: Array<Record<string, unknown>> = [];
  for (const entry of logged) {
    // Defensive: only PERSISTENT_TYPES ever get a seq, but older logs
    // may contain stragglers. Keep parity with handleSessionMessages.
    if (!RelayClient.PERSISTENT_TYPES.has(entry.type)) continue;
    try {
      const m = JSON.parse(entry.payload);
      m.seq = entry.seq;
      parsed.push(m);
    } catch {
      logger.warn({ seq: entry.seq, sessionId }, 'Failed to parse session message for range batch');
    }
  }

  const batchMsg = {
    type: 'session_messages_range_batch',
    deviceId: client.authInfo?.deviceId ?? '',
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: {
      sessionId,
      messages: parsed,
      firstSeq: parsed.length > 0 ? (parsed[0].seq as number) : 0,
      lastSeq: parsed.length > 0 ? ((parsed.at(-1) as Record<string, unknown>).seq as number) : 0,
      truncated,
    },
  };
  const bytes = client.sendReliableUnicastTo(requesterDeviceId, requesterKey, batchMsg);
  logger.info(
    { requesterDeviceId, sessionId, fromSeq, toSeq, lo, hi, headSeq, count: parsed.length, truncated, bytes, transport: client.transportTo(requesterDeviceId) },
    'Replied to range session messages request',
  );
}

/**
 * Reply to `request_turn_trace` — the tool trace for one turn, read from
 * `trace.jsonl` and keyed by the concluding bubble's spine seq. Unicast the
 * `turn_trace_batch` back to the requester.
 */
export function handleTurnTrace(
  client: RelayClient,
  requesterDeviceId: string,
  sessionId: string,
  bubbleSeq: number,
): void {
  const requesterKey = client.consumerKeys.get(requesterDeviceId);
  if (!requesterKey) {
    logger.warn({ requesterDeviceId }, 'Turn trace requested but no encryption key for requester');
    return;
  }

  const meta = client.sessionManager.getMeta(sessionId);
  let entries: unknown[] = [];
  let complete = false;
  if (meta) {
    const result = client.sessionManager.readTurnTrace(sessionId, Math.floor(bubbleSeq));
    entries = result.entries;
    complete = result.complete;
  }

  const batchMsg = {
    type: 'turn_trace_batch',
    deviceId: client.authInfo?.deviceId ?? '',
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: { sessionId, bubbleSeq, entries, complete },
  };
  const bytes = client.sendReliableUnicastTo(requesterDeviceId, requesterKey, batchMsg);
  logger.info({ requesterDeviceId, sessionId, bubbleSeq, count: entries.length, complete, bytes, transport: client.transportTo(requesterDeviceId) }, 'Replied to turn trace request');
}

export function handleSetSessionSubscription(client: RelayClient, requesterDeviceId: string, sessionId: string | null, requestId?: string): void {
  const requesterKey = client.consumerKeys.get(requesterDeviceId);
  if (!requesterKey) {
    logger.warn({ requesterDeviceId, sessionId }, 'Session subscription requested without requester key');
    return;
  }

  if (sessionId === null) {
    client.currentSessionByArm.set(requesterDeviceId, null);
    client.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
      type: 'session_subscription_set',
      deviceId: client.authInfo?.deviceId ?? '',
      seq: ++client.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { accepted: true, sessionId: null, snapshot: null, ...(requestId && { requestId }) },
    });
    return;
  }

  const digest = client.enrichSessionList(client.sessionManager.getSessionList())
    .find((session) => session.id === sessionId) as SessionDigest | undefined;
  if (!digest) {
    client.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
      type: 'session_subscription_set',
      deviceId: client.authInfo?.deviceId ?? '',
      seq: ++client.seqCounter,
      timestamp: new Date().toISOString(),
      payload: {
        accepted: false,
        sessionId,
        ...(requestId && { requestId }),
        error: { code: 'session_not_found', message: 'Session not found' },
      },
    });
    return;
  }

  // Flush any debounced delta first. card.state() already contains that
  // text, so flushing it after joining would deliver it twice (in the
  // snapshot draft and again as the delayed delta). Flushed now, it reaches
  // only the existing subscribers.
  client.flushDelta(sessionId);
  // Replace membership before capturing/enqueuing the ACK. Any subsequent
  // card event for this session is sent after the snapshot on stream 0.
  client.currentSessionByArm.set(requesterDeviceId, sessionId);
  const card = client.card.state(sessionId);
  const snapshot: SessionLiveSnapshot = {
    digest,
    spineHeadSeq: digest.lastSeq,
    card: { draft: card.draft, action: card.action },
  };
  client.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
    type: 'session_subscription_set',
    deviceId: client.authInfo?.deviceId ?? '',
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: { accepted: true, sessionId, snapshot, ...(requestId && { requestId }) },
  });
}

/** Reply to `request_card` — unicast the session's current card snapshot
 *  (agent_message_delta full text + current card_action) to the requester. */
export function handleRequestCard(client: RelayClient, requesterDeviceId: string, sessionId: string): void {
  const requesterKey = client.consumerKeys.get(requesterDeviceId);
  if (!requesterKey) {
    logger.warn({ requesterDeviceId }, 'Card requested but no encryption key for requester');
    return;
  }
  // Same reason as handleSetSessionSubscription: never snapshot text that a
  // debounced delta is about to deliver again.
  client.flushDelta(sessionId);
  for (const snap of client.card.snapshot(sessionId)) {
    const enriched = {
      ...snap,
      deviceId: client.authInfo?.deviceId ?? '',
      seq: ++client.seqCounter,
      timestamp: new Date().toISOString(),
    };
    client.sendReliableUnicastTo(requesterDeviceId, requesterKey, enriched);
  }
}
