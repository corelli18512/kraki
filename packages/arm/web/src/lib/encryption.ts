import type { Message, InnerMessage } from '@kraki/protocol';
import type { AppKeyStore, RecipientKey } from './e2e';
import { getStore } from './store-adapter';
import type { MessageHandler } from './transport';

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
   * Encrypt an outbound message as a UnicastEnvelope for the tentacle
   * that owns the target session.
   */
  async encryptOutbound(
    msg: Record<string, unknown>,
    send: (msg: Record<string, unknown>) => void,
  ): Promise<void> {
    if (!this.keyStore.isReady()) {
      // Cannot send without encryption in the thin relay protocol
      console.error('[Kraki] Cannot send — key store not ready');
      return;
    }

    const store = getStore();

    // Determine the target tentacle device for unicast routing
    let targetDeviceId: string | undefined;
    const sessionId = msg.sessionId as string | undefined;
    if (msg.type === 'create_session') {
      const payload = msg.payload as Record<string, unknown> | undefined;
      targetDeviceId = payload?.targetDeviceId as string | undefined;
    } else if (sessionId) {
      const session = store.sessions.get(sessionId);
      targetDeviceId = session?.deviceId;
    }

    if (!targetDeviceId) {
      console.error('[Kraki] Cannot send — no target device for unicast');
      return;
    }

    // For unicast, only encrypt for the target device
    const targetDev = store.devices.get(targetDeviceId);
    const targetKey = targetDev?.encryptionKey ?? targetDev?.publicKey;
    if (!targetKey) {
      console.error('[Kraki] Cannot send — no encryption key for target device');
      return;
    }
    const recipients: RecipientKey[] = [{ deviceId: targetDeviceId, publicKeyBase64: targetKey }];

    try {
      const plaintext = JSON.stringify(msg);
      const { blob, keys } = await this.keyStore.encryptToBlob(plaintext, recipients);
      send({
        type: 'unicast',
        to: targetDeviceId,
        blob,
        keys,
      });
    } catch (err) {
      console.error('[Kraki] Outbound encryption failed:', err);
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
      console.error('[Kraki] E2E decryption failed:', err);
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
