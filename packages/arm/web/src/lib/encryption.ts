import type { Message, InnerMessage } from '@kraki/protocol';
import type { AppKeyStore, RecipientKey } from './e2e';
import { createLogger } from './logger';
import { getStore } from './store-adapter';
import type { MessageHandler } from './transport';

const logger = createLogger('encryption');

export interface EncryptionCallbacks {
  handleDataMessage: (msg: InnerMessage) => void;
  getHandlers: () => MessageHandler[];
}

/** Handles E2E encrypted message decryption and outbound encryption. */
export class EncryptionHandler {
  keyStore: AppKeyStore;
  private encryptedQueue: any[] = [];

  constructor(keyStore: AppKeyStore) {
    this.keyStore = keyStore;
  }

  /**
   * Encrypt an outbound message as a UnicastEnvelope (default) or BroadcastEnvelope.
   * When broadcast=true, encrypts for ALL known devices.
   */
  async encryptOutbound(
    msg: Record<string, unknown>,
    send: (msg: Record<string, unknown>) => void,
    options?: { broadcast?: boolean },
  ): Promise<void> {
    if (!this.keyStore.isReady()) {
      logger.error('Cannot send — key store not ready');
      return;
    }

    const store = getStore();

    if (options?.broadcast) {
      // Broadcast: encrypt for all known devices
      const recipients: RecipientKey[] = [];
      for (const [, dev] of store.devices) {
        const key = dev.encryptionKey ?? dev.publicKey;
        if (key && dev.id !== store.deviceId) {
          recipients.push({ deviceId: dev.id, publicKeyBase64: key });
        }
      }
      if (recipients.length === 0) {
        logger.error('Cannot broadcast — no recipient devices');
        return;
      }
      try {
        const plaintext = JSON.stringify(msg);
        const { blob, keys } = await this.keyStore.encryptToBlob(plaintext, recipients);
        send({ type: 'broadcast', blob, keys });
      } catch (err) {
        logger.error('Outbound broadcast encryption failed:', err);
      }
      return;
    }

    // Unicast: determine the target tentacle device
    let targetDeviceId: string | undefined;
    const sessionId = msg.sessionId as string | undefined;
    const payload = msg.payload as Record<string, unknown> | undefined;
    if (payload?.targetDeviceId) {
      targetDeviceId = payload.targetDeviceId as string;
    } else if (sessionId) {
      const session = store.sessions.get(sessionId);
      targetDeviceId = session?.deviceId;
    }

    if (!targetDeviceId) {
      logger.error('Cannot send — no target device for unicast');
      getStore().setLastError('Cannot send: no target device found for this session. Try reconnecting.');
      return;
    }

    // For unicast, only encrypt for the target device
    const targetDev = store.devices.get(targetDeviceId);
    const targetKey = targetDev?.encryptionKey ?? targetDev?.publicKey;
    if (!targetKey) {
      logger.error('Cannot send — no encryption key for target device');
      getStore().setLastError('Cannot send: target device has no encryption key. Try reconnecting.');
      return;
    }
    const recipients: RecipientKey[] = [{ deviceId: targetDeviceId, publicKeyBase64: targetKey }];

    try {
      const plaintext = JSON.stringify(msg);
      const { blob, keys } = await this.keyStore.encryptToBlob(plaintext, recipients);
      const envelope: Record<string, unknown> = {
        type: 'unicast',
        to: targetDeviceId,
        blob,
        keys,
      };
      // Set ref to requestId so relay echoes it back in server_error
      if (msg.type === 'create_session') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (payload?.requestId) {
          envelope.ref = payload.requestId;
        }
      }
      send(envelope);
    } catch (err) {
      logger.error('Outbound encryption failed:', err);
    }
  }

  /** Handle an incoming BroadcastEnvelope or UnicastEnvelope. */
  async handleEncrypted(
    msg: {
      type: 'broadcast' | 'unicast';
      blob: string;
      keys: Record<string, string>;
      [key: string]: unknown;
    },
    callbacks: EncryptionCallbacks,
  ): Promise<void> {
    const store = getStore();
    const deviceId = store.deviceId;

    if (!deviceId || !this.keyStore.isReady()) {
      this.encryptedQueue.push(msg);
      return;
    }

    // No wrapped key for this device — not addressed to us
    if (!msg.keys[deviceId]) {
      return;
    }

    try {
      const plaintext = await this.keyStore.decryptFromBlob(
        { blob: msg.blob, keys: msg.keys },
        deviceId,
      );
      const inner = JSON.parse(plaintext) as InnerMessage;

      callbacks.handleDataMessage(inner);
      callbacks.getHandlers().forEach((h) => h(inner as unknown as Message));
    } catch (err) {
      logger.error('E2E decryption failed:', err);
      // Try to extract sessionId from the error context for user feedback
      // (inner is not available on decryption failure)
    }
  }

  /** Retry queued encrypted messages after keystore becomes ready. */
  async drainEncryptedQueue(callbacks: EncryptionCallbacks): Promise<void> {
    if (!this.keyStore.isReady() || this.encryptedQueue.length === 0) return;
    const queued = this.encryptedQueue.splice(0);
    for (const msg of queued) {
      await this.handleEncrypted(msg, callbacks);
    }
  }
}
