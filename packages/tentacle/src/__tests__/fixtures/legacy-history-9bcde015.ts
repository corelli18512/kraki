/**
 * Frozen copy of handleSessionMessages as shipped before PR #577 (from
 * commit 9bcde015, packages/tentacle/src/relay/history.ts). Used to check
 * that new apps (sending `afterSeq`) still work against older Tentacles.
 * Do not update it: it stands for the deployed old version.
 */
/* eslint-disable */
import { RelayClient as RelayClientValue } from '../../relay-client.js';

const logger = { info: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {} };
const RelayClient = RelayClientValue;

export function handleSessionMessages(client: InstanceType<typeof RelayClientValue>, requesterDeviceId: string, sessionId: string, beforeSeq: number | undefined): void {
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
      lastSeq: parsed.length > 0 ? (parsed.at(-1) as Record<string, unknown>).seq as number : startSeq - 1,
      containsHead: endSeqInclusive >= headSeq,
    },
  };
  logger.info(
    { requesterDeviceId, sessionId, beforeSeq, startSeq, endSeqInclusive, count: parsed.length },
    'Replied to turn-aware session messages request',
  );
  client.sendReliableUnicastTo(requesterDeviceId, requesterKey, batchMsg);
}

