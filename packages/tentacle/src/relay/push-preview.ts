/** Push notification previews for a finished turn. */

import type { ProducerMessage, CardActionState } from '@kraki/protocol';
import { HEAD_PULSE_TARGET } from '@kraki/protocol';
import { randomUUID } from 'node:crypto';
import { importPublicKey, encryptToBlob } from '@kraki/crypto';
import type { RecipientKey } from '@kraki/crypto';
import { toWellFormedText } from '../session-manager.js';
import { markdownToPlainText, truncateUtf8, PUSH_SUMMARY_MAX_BYTES } from '../push-preview-text.js';
import type { RelayClient } from '../relay-client.js';
import { logger, traceLog } from './shared.js';

/** Largest `v2.` preview key: leaves room for the APNs `aps` object (~200 B). */
const TRUSTED_PREVIEW_MAX_CHARS = 3_700;

/** Build and dispatch an encrypted push preview over the Head self-channel.
 *  This operation is independent of live subscribers and online targets. */
export function dispatchPushPreview(client: RelayClient, msg: Partial<ProducerMessage>): void {
  const built = buildPushPreview(client, msg);
  if (!built) return;
  // Legacy (RSA, shared blob) and device-trust (per-app, blob-less) previews
  // go as separate dispatches: the Head forwards `{blob, key}` per device, and
  // a paired phone must not also carry the unused legacy blob (APNs 4 KB).
  for (const preview of [built.encrypted, built.trusted]) {
    if (!preview) continue;
    client.pulse.send(
      JSON.stringify({ type: 'dispatch_push', payload: { preview } }),
      HEAD_PULSE_TARGET,
      false,
      undefined,
      0,
    );
  }
  // Same-machine Apps also get the preview straight over the local link, so
  // a Mac whose Head connection is down notifies in step with the messages
  // it already sees over the link. The Head copy still goes out (it covers
  // a link that drops at this instant); both carry the same `nid` and the
  // App posts each notification once.
  for (const appId of client.localLink?.peerIds() ?? []) {
    const key = client.consumerKeys.get(appId);
    // A paired app is reached with its pinned keys even without an RSA key.
    if (!key || !(client.deviceTrust?.isTrusted(appId) || (built.encrypted && appId in built.encrypted.keys))) continue;
    client.sendReliableUnicastTo(appId, key, {
      type: 'local_notification',
      deviceId: client.authInfo?.deviceId ?? '',
      seq: ++client.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { preview: built.plaintext },
    });
  }
}

/** Build the encrypted push preview for a notification-worthy message. */
export function buildPushPreview(
  client: RelayClient,
  msg: Partial<ProducerMessage>,
): {
  /** Legacy RSA preview for unpaired apps (compatible mode only). */
  encrypted: { blob: string; keys: Record<string, string> } | null;
  /** Signed X25519 previews for paired apps (`v2.` keys, empty blob). */
  trusted: { blob: string; keys: Record<string, string> } | null;
  plaintext: string;
} | undefined {
  let previewType: string | undefined;
  let previewSummary: string | undefined;
  if (msg.type === 'card_action') {
    // A permission warrants an offline push — a human must act on it.
    // Tool/tool_batch actions are ambient progress (no push). Skip resolved
    // prompts: the push is for the initial ask only.
    const action = (msg.payload as { action?: CardActionState | null } | undefined)?.action;
    if (action?.type === 'permission' && action.payload.decision === undefined) {
      previewType = 'permission';
      previewSummary = action.payload.description || action.payload.toolName;
    }
  } else if (msg.type === 'agent_message'
    && (msg.payload as { question?: unknown } | undefined)?.question) {
    previewType = 'question';
    previewSummary = (msg.payload as { question: { text: string } }).question.text;
  } else if (msg.type === 'idle') {
    // Only the idle that closes a real user turn notifies; create/import/fork
    // idles bypass sendTurnIdle and never push. The summary is THIS turn's
    // reply (never a previous turn's); a failed turn pushes its error; a
    // reply-less turn pushes with no summary (clients show a generic line).
    const closing = client.closingTurnPush.get(msg.sessionId as string);
    if (!closing) return undefined;
    if (closing.failure !== undefined) {
      previewType = 'error';
      previewSummary = closing.failure;
    } else {
      previewType = 'idle';
      previewSummary = client.lastAgentContent.get(msg.sessionId as string) ?? '';
    }
  }
  if (!previewType || previewSummary === undefined) return undefined;
  const normalizedSummary = truncateUtf8(markdownToPlainText(previewSummary), PUSH_SUMMARY_MAX_BYTES);
  if (!normalizedSummary && previewType !== 'idle') return undefined;
  const meta = client.sessionManager.getMeta(msg.sessionId as string);
  const rawTitle = meta?.title ?? meta?.autoTitle;
  const normalizedTitle = rawTitle ? toWellFormedText(rawTitle).replace(/\s+/g, ' ').trim() : undefined;
  const title = normalizedTitle
    ? Array.from(normalizedTitle).slice(0, 80).join('')
    : undefined;

  // Encrypt to ALL consumerKeys (online + offline). The push preview is
  // specifically for offline delivery — online devices already got the real
  // message via the live pulse stream.
  const previewRecipients: RecipientKey[] = [];
  const pairedRecipients: string[] = [];
  for (const [deviceId, compactKey] of client.consumerKeys) {
    // Paired apps get a signed X25519 preview of their own (below).
    if (client.deviceTrust?.isTrusted(deviceId)) {
      pairedRecipients.push(deviceId);
      continue;
    }
    // Enforced: nothing for apps that are not paired, whatever is cached.
    if (client.deviceTrust?.enforced) continue;
    try {
      previewRecipients.push({ deviceId, publicKey: importPublicKey(compactKey) });
    } catch {
      // skip invalid keys
    }
  }
  if (previewRecipients.length === 0 && pairedRecipients.length === 0 && !client.localLink?.peerIds().length) return undefined;
  traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'PUSH-PREVIEW-BUILD', previewType, recipientCount: previewRecipients.length, onlineCount: client.onlineConsumers.size, offlineCount: previewRecipients.length - client.onlineConsumers.size });
  try {
    const nid = randomUUID();
    const steps = client.turnStepCounts.get(msg.sessionId as string) ?? 0;
    const render = (summary: string | undefined) => JSON.stringify({
      // Notification id: lets an App that receives the same preview over
      // two routes (local link + Head) post it once.
      nid,
      type: previewType,
      ...(summary && { summary }),
      ...(previewType === 'idle' && !normalizedSummary && { steps }),
      sessionId: msg.sessionId,
      ...(title ? { title } : {}),
    });
    const preview = render(normalizedSummary);
    let encrypted: { blob: string; keys: Record<string, string> } | null = null;
    if (previewRecipients.length > 0) {
      const legacy = encryptToBlob(preview, previewRecipients);
      encrypted = { blob: legacy.blob, keys: legacy.keys };
    }
    let trusted: { blob: string; keys: Record<string, string> } | null = null;
    for (const appId of pairedRecipients) {
      // Signing, escaping and the envelope add size: shorten the summary
      // until the whole APNs payload fits in 4 KB.
      let summary = normalizedSummary;
      let sealed = client.deviceTrust!.sealPushPreview(render(summary), appId);
      while (sealed && sealed.length > TRUSTED_PREVIEW_MAX_CHARS && summary) {
        summary = truncateUtf8(summary, Math.floor(Buffer.byteLength(summary) * 0.6));
        sealed = client.deviceTrust!.sealPushPreview(render(summary), appId);
      }
      if (!sealed) continue;
      trusted ??= { blob: '', keys: {} };
      trusted.keys[appId] = sealed;
    }
    return { encrypted, trusted, plaintext: preview };
  } catch (err) {
    logger.debug({ err }, 'Pulse push-preview build failed');
    return undefined;
  }
}
