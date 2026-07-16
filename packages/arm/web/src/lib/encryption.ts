import type { Message, InnerMessage } from '@kraki/protocol';
import type { AppKeyStore } from './e2e';
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
  private encryptedQueue: Array<{
    type: 'broadcast' | 'unicast';
    blob: string;
    keys: Record<string, string>;
    [key: string]: unknown;
  }> = [];

  constructor(keyStore: AppKeyStore) {
    this.keyStore = keyStore;
  }

  /** Encrypt a message for its target tentacle and return the parts WITHOUT
   *  sending — so the pulse layer can carry the blob. Resolves the target from
   *  `payload.targetDeviceId` or the session's deviceId. Returns null if no
   *  target/key. */
  async encryptForTarget(
    msg: Record<string, unknown>,
  ): Promise<{ blob: string; keys: Record<string, string>; to: string } | null> {
    if (!this.keyStore.isReady()) return null;
    const store = getStore();
    let targetDeviceId: string | undefined;
    const sessionId = msg.sessionId as string | undefined;
    const payload = msg.payload as Record<string, unknown> | undefined;
    if (payload?.targetDeviceId) targetDeviceId = payload.targetDeviceId as string;
    else if (sessionId) targetDeviceId = store.sessions.get(sessionId)?.deviceId;
    if (!targetDeviceId) return null;
    const targetDev = store.devices.get(targetDeviceId);
    const targetKey = targetDev?.encryptionKey ?? targetDev?.publicKey;
    if (!targetKey) return null;
    try {
      const { blob, keys } = await this.keyStore.encryptToBlob(JSON.stringify(msg), [
        { deviceId: targetDeviceId, publicKeyBase64: targetKey },
      ]);
      return { blob, keys, to: targetDeviceId };
    } catch (err) {
      logger.error('encryptForTarget failed:', err);
      return null;
    }
  }

  /** Encrypt an inner message for an explicitly routed device without adding a
   *  targetDeviceId field to the encrypted protocol payload. */
  async encryptForDevice(
    msg: Record<string, unknown>,
    targetDeviceId: string,
  ): Promise<{ blob: string; keys: Record<string, string>; to: string } | null> {
    if (!this.keyStore.isReady()) return null;
    const targetDev = getStore().devices.get(targetDeviceId);
    const targetKey = targetDev?.encryptionKey ?? targetDev?.publicKey;
    if (!targetKey) return null;
    try {
      const { blob, keys } = await this.keyStore.encryptToBlob(JSON.stringify(msg), [
        { deviceId: targetDeviceId, publicKeyBase64: targetKey },
      ]);
      return { blob, keys, to: targetDeviceId };
    } catch (err) {
      logger.error('encryptForDevice failed:', err);
      return null;
    }
  }

  /** Decrypt a raw blob+keys (used by the pulse inbound path). */
  async decryptBlob(blob: string, keys: Record<string, string>): Promise<InnerMessage | null> {
    const store = getStore();
    const deviceId = store.deviceId;
    if (!deviceId || !this.keyStore.isReady()) return null;
    try {
      const plaintext = await this.keyStore.decryptFromBlob({ blob, keys }, deviceId);
      return JSON.parse(plaintext) as InnerMessage;
    } catch (err) {
      logger.error('decryptBlob failed:', err);
      return null;
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
      logger.error('E2E decryption failed:', err instanceof Error ? { name: err.name, message: err.message } : err);
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
