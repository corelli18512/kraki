import type { ProducerMessage, ConsumerMessage, HeadNotice, SessionCreatedMessage, CreateSessionMessage, EncryptedMessage } from '@kraki/protocol';
import { ChannelManager } from './channel-manager.js';
import { shouldStore } from './storage.js';
import { getLogger } from './logger.js';

/** Normalize SQLite datetime ("2024-01-15 20:00:00") to ISO 8601 ("2024-01-15T20:00:00.000Z") */
function toISO(sqliteTimestamp: string): string {
  if (sqliteTimestamp.includes('T')) return sqliteTimestamp; // already ISO
  return sqliteTimestamp.replace(' ', 'T') + '.000Z';
}

type IncomingMessage = ProducerMessage | ConsumerMessage | EncryptedMessage;

export class Router {
  private cm: ChannelManager;

  constructor(cm: ChannelManager) {
    this.cm = cm;
  }

  /**
   * Handle an incoming message from a connected device.
   * Assigns seq, stores if needed, routes to correct recipients.
   */
  handleMessage(fromDeviceId: string, raw: IncomingMessage): void {
    const device = this.cm.getConnection(fromDeviceId);
    if (!device) return;

    const channelId = device.channelId;
    const seq = this.cm.nextSeq(channelId);
    const logger = getLogger();

    // Track session ownership on session_created (narrow on raw, not stamped)
    if (raw.type === 'session_created' && raw.sessionId) {
      const payload = (raw as SessionCreatedMessage).payload;
      this.cm.registerSession(raw.sessionId, fromDeviceId, {
        agent: payload.agent,
        model: payload.model,
      });
      logger.debug('Session registered', { sessionId: raw.sessionId, device: fromDeviceId, agent: payload.agent });
    }

    // In E2E mode, encrypted messages from tentacles may contain session_created.
    // The tentacle exposes agent/model in the outer envelope for session registration.
    if (device.role === 'tentacle' && raw.sessionId && !this.cm.getSessionOwner(raw.sessionId)) {
      const enc = raw.type === 'encrypted' ? raw as EncryptedMessage : null;
      this.cm.registerSession(raw.sessionId, fromDeviceId, {
        agent: enc?.agent ?? (raw as SessionCreatedMessage).payload?.agent ?? 'unknown',
        model: enc?.model ?? (raw as SessionCreatedMessage).payload?.model,
      });
      logger.debug('Session registered (from envelope)', { sessionId: raw.sessionId, device: fromDeviceId });
    }

    // Stamp envelope fields
    const stamped = {
      ...raw,
      channel: channelId,
      deviceId: fromDeviceId,
      seq,
      timestamp: new Date().toISOString(),
    };

    // Store if this is a storable message type (skip ephemeral messages like deltas)
    const isEphemeral = stamped.type === 'encrypted' && (stamped as EncryptedMessage).ephemeral;
    if (shouldStore(stamped.type) && !isEphemeral) {
      // For encrypted messages, store the full envelope (head can't read the inner payload)
      let payloadToStore: string;
      if (stamped.type === 'encrypted') {
        const enc = stamped as EncryptedMessage & { channel: string; seq: number; timestamp: string };
        payloadToStore = JSON.stringify({ iv: enc.iv, ciphertext: enc.ciphertext, tag: enc.tag, keys: enc.keys });
      } else {
        payloadToStore = JSON.stringify((stamped as { payload?: unknown }).payload);
      }

      this.cm.getStorage().storeMessage({
        channelId,
        deviceId: fromDeviceId,
        sessionId: stamped.sessionId ?? null,
        seq,
        type: stamped.type,
        payload: payloadToStore,
      });
    }

    const serialized = JSON.stringify(stamped);

    // Route based on sender role
    if (device.role === 'tentacle') {
      this.sendToApps(channelId, serialized);
      logger.debug('Routed tentacle→apps', { type: stamped.type, seq, channel: channelId });
    } else if (device.role === 'app') {
      // Encrypted create_session: targetDeviceId in outer envelope
      const targetDeviceId = raw.type === 'create_session'
        ? (raw as CreateSessionMessage).payload?.targetDeviceId
        : (raw as EncryptedMessage).targetDeviceId;

      if (targetDeviceId) {
        const requestId = raw.type === 'create_session'
          ? (raw as CreateSessionMessage).payload?.requestId
          : undefined;
        this.sendToTentacle(channelId, targetDeviceId, serialized, logger, fromDeviceId, requestId);
      } else {
        this.sendToSessionOwner(stamped.sessionId, serialized);
        logger.debug('Routed app→tentacle', { type: stamped.type, seq, sessionId: stamped.sessionId });
      }
    }
  }

  /**
   * Replay stored messages to a device after a given seq.
   */
  replay(deviceId: string, afterSeq: number, sessionId?: string): void {
    const device = this.cm.getConnection(deviceId);
    if (!device) return;

    const logger = getLogger();
    const messages = this.cm.getStorage().getMessagesAfterSeq(
      device.channelId, afterSeq, sessionId,
    );

    let sent = 0;
    let skipped = 0;

    for (const msg of messages) {
      try {
        let envelope: Record<string, unknown>;

        if (msg.type === 'encrypted') {
          // Encrypted messages: reconstruct original wire format
          const stored = JSON.parse(msg.payload);
          envelope = {
            channel: msg.channelId,
            deviceId: msg.deviceId,
            seq: msg.seq,
            timestamp: toISO(msg.createdAt),
            type: 'encrypted',
            sessionId: msg.sessionId,
            iv: stored.iv,
            ciphertext: stored.ciphertext,
            tag: stored.tag,
            keys: stored.keys,
          };
        } else {
          // Normal messages: reconstruct envelope with parsed payload
          envelope = {
            channel: msg.channelId,
            deviceId: msg.deviceId,
            seq: msg.seq,
            timestamp: toISO(msg.createdAt),
            type: msg.type,
            sessionId: msg.sessionId,
            payload: JSON.parse(msg.payload),
          };
        }

        device.send(JSON.stringify(envelope));
        sent++;
      } catch {
        logger.warn('Skipped corrupt message during replay', {
          messageId: msg.id,
          seq: msg.seq,
          type: msg.type,
        });
        skipped++;
      }
    }

    logger.debug('Replay complete', { deviceId, afterSeq, sent, skipped });
  }

  /**
   * Send a HeadNotice to all connected devices on a channel.
   */
  broadcastNotice(channelId: string, notice: HeadNotice): void {
    const serialized = JSON.stringify(notice);
    for (const device of this.cm.getConnectedDevices(channelId)) {
      device.send(serialized);
    }
  }

  private broadcastToTentacles(channelId: string, notice: HeadNotice): void {
    const serialized = JSON.stringify(notice);
    for (const tentacle of this.cm.getConnectedByRole(channelId, 'tentacle')) {
      tentacle.send(serialized);
    }
  }

  private sendToApps(channelId: string, data: string): void {
    for (const app of this.cm.getConnectedByRole(channelId, 'app')) {
      app.send(data);
    }
  }

  private sendToSessionOwner(sessionId: string | undefined, data: string): void {
    if (!sessionId) return;
    const ownerDeviceId = this.cm.getSessionOwner(sessionId);
    if (!ownerDeviceId) return;
    const device = this.cm.getConnection(ownerDeviceId);
    if (device) device.send(data);
  }

  /**
   * Route create_session to a specific tentacle.
   * Works for both plaintext and encrypted (targetDeviceId from envelope).
   */
  private sendToTentacle(
    channelId: string,
    targetDeviceId: string,
    serialized: string,
    logger: ReturnType<typeof getLogger>,
    fromDeviceId?: string,
    requestId?: string,
  ): void {
    const device = this.cm.getConnection(targetDeviceId);
    // Verify target is a tentacle in the SAME channel
    if (device && device.role === 'tentacle' && device.channelId === channelId) {
      device.send(serialized);
      logger.debug('Routed create_session→tentacle', { targetDeviceId });
    } else {
      const reason = device && device.channelId !== channelId
        ? `Target device "${targetDeviceId}" belongs to a different channel`
        : `Target device "${targetDeviceId}" is not online`;
      logger.warn('create_session rejected', { targetDeviceId, reason });
      if (fromDeviceId) {
        const sender = this.cm.getConnection(fromDeviceId);
        if (sender) {
          sender.send(JSON.stringify({
            type: 'server_error',
            message: reason,
            requestId,
          }));
        }
      }
    }
  }
}
