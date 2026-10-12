/** Attachment requests: chunked, paced transfer to one app. */

import type { ConsumerMessage } from '@kraki/protocol';
import { RelayClient } from '../relay-client.js';
import { logger } from './shared.js';

/**
 * Serve a `request_attachment` from a consumer device. Paced requests get
 * exactly the requested chunk now; legacy whole-file requests are queued and
 * rate-limited so they cannot saturate the relay link.
 */
export async function handleRequestAttachment(client: RelayClient, msg: ConsumerMessage): Promise<void> {
  if (msg.type !== 'request_attachment') return;
  const { id, sessionId } = msg.payload;
  const requesterDeviceId = msg.deviceId;
  const requesterKey = client.consumerKeys.get(requesterDeviceId);
  if (!requesterKey) {
    logger.warn({ requesterDeviceId }, 'request_attachment: no key for requester');
    return;
  }
  if (!client.attachmentStore) {
    unicastAttachmentError(client, requesterDeviceId, requesterKey, sessionId, id, 'not_found');
    return;
  }
  if (msg.payload.mode === 'paced') {
    // One chunk per request: read just that range, not the whole file.
    const chunk = RelayClient.ATTACHMENT_CHUNK_BYTES;
    const index = Math.floor(msg.payload.index ?? 0);
    const got = index >= 0 ? client.attachmentStore.readRange(sessionId, id, index * chunk, chunk) : null;
    const total = got ? Math.max(1, Math.ceil(got.size / chunk)) : 0;
    if (!got || index >= total) {
      unicastAttachmentError(client, requesterDeviceId, requesterKey, sessionId, id, 'not_found');
      return;
    }
    const wire = sendAttachmentChunk(client, requesterDeviceId, requesterKey, sessionId, id, got.meta.mimeType, index, total, got.bytes, true);
    client.attachmentPacer.charge(wire);
    return;
  }
  const got = client.attachmentStore.read(sessionId, id);
  if (!got) {
    unicastAttachmentError(client, requesterDeviceId, requesterKey, sessionId, id, 'not_found');
    return;
  }
  // Legacy whole-file request: queued and rate-limited by the pacer.
  client.attachmentPacer.enqueue({
    deviceId: requesterDeviceId,
    sessionId,
    id,
    bytes: got.bytes,
    mimeType: got.meta.mimeType,
  });
}

/** Send one attachment chunk; returns its estimated wire size. */
export function sendAttachmentChunk(
  client: RelayClient,
  deviceId: string,
  key: string,
  sessionId: string,
  id: string,
  mimeType: string,
  index: number,
  total: number,
  slice: Buffer,
  paced: boolean,
): number {
  const data = slice.toString('base64');
  const chunkMsg = {
    type: 'attachment_data' as const,
    deviceId: client.authInfo?.deviceId ?? '',
    sessionId,
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: {
      id,
      index,
      total,
      mimeType,
      data,
      ...(paced && { paced: true as const }),
    },
  };
  client.sendReliableUnicastTo(deviceId, key, chunkMsg);
  // base64 payload → AES blob base64 → Pulse frame base64.
  return Math.ceil(data.length * 1.8);
}

export function unicastAttachmentError(
  client: RelayClient,
  requesterDeviceId: string,
  requesterKey: string,
  sessionId: string,
  id: string,
  error: 'not_found' | 'unauthorized' | 'too_large',
): void {
  const errorMsg = {
    type: 'attachment_data' as const,
    deviceId: client.authInfo?.deviceId ?? '',
    sessionId,
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: { id, index: 0, total: 0, mimeType: '', data: '', error },
  };
  client.sendReliableUnicastTo(requesterDeviceId, requesterKey, errorMsg);
}
