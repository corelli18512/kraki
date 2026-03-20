import type { Message } from '@kraki/protocol';
import type { AppKeyStore, RecipientKey } from './e2e';
import { getStore } from './store-adapter';
import type { MessageHandler } from './transport';

export interface EncryptionCallbacks {
  updateSeq: (seq: number) => void;
  handleDataMessage: (msg: Message) => void;
  getHandlers: () => MessageHandler[];
}

/** Handles E2E encrypted message decryption and outbound encryption. */
export class EncryptionHandler {
  keyStore: AppKeyStore;
  e2eEnabled = false;
  private encryptedQueue: any[] = [];

  constructor(keyStore: AppKeyStore) {
    this.keyStore = keyStore;
  }

  /**
   * Encrypt an outbound message for all tentacle devices on the channel.
   * Returns the encrypted envelope, or null if encryption is not possible
   * (falls back to plaintext).
   */
  async encryptOutbound(
    msg: Record<string, unknown>,
    send: (msg: Record<string, unknown>) => void,
  ): Promise<void> {
    if (!this.e2eEnabled || !this.keyStore.isReady()) {
      send(msg);
      return;
    }

    const store = getStore();
    const recipients: RecipientKey[] = [];
    // Include ALL devices (tentacles + apps) so everyone can decrypt on replay
    for (const [id, dev] of store.devices) {
      const key = dev.encryptionKey ?? dev.publicKey;
      if (key) recipients.push({ deviceId: id, publicKeyBase64: key });
    }

    if (recipients.length === 0) {
      send(msg);
      return;
    }

    try {
      const plaintext = JSON.stringify(msg);
      const encrypted = await this.keyStore.encrypt(plaintext, recipients);
      const envelope: Record<string, unknown> = {
        type: 'encrypted',
        sessionId: msg.sessionId,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        tag: encrypted.tag,
        keys: encrypted.keys,
      };
      // Expose targetDeviceId for create_session routing (head needs it)
      if (msg.type === 'create_session' && (msg.payload as any)?.targetDeviceId) {
        envelope.targetDeviceId = (msg.payload as any).targetDeviceId;
      }
      // Mark ephemeral messages — head forwards but doesn't persist
      if (msg.type === 'kill_session') {
        envelope.ephemeral = true;
      }
      send(envelope);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('[Kraki] Outbound encryption failed, sending plaintext:', err);
      }
      send(msg);
    }
  }

  async handleEncrypted(
    msg: {
      type: 'encrypted';
      iv: string;
      ciphertext: string;
      tag: string;
      keys: Record<string, string>;
      seq?: number;
      [key: string]: unknown;
    },
    callbacks: EncryptionCallbacks,
  ): Promise<void> {
    const store = getStore();
    const deviceId = store.deviceId;

    if (!deviceId || !this.keyStore.isReady()) {
      // Queue for retry after keystore is ready (don't advance seq — we'll retry)
      this.encryptedQueue.push(msg);
      return;
    }

    // No wrapped key for this device — not addressed to us, advance seq and skip
    if (!msg.keys[deviceId]) {
      if (msg.seq && typeof msg.seq === 'number') {
        callbacks.updateSeq(msg.seq);
      }
      return;
    }

    try {
      const plaintext = await this.keyStore.decrypt(msg, deviceId);
      const inner = JSON.parse(plaintext) as Message;

      // Decrypt succeeded — advance seq
      if (msg.seq && typeof msg.seq === 'number') {
        callbacks.updateSeq(msg.seq);
      }

      // Re-stamp envelope fields from the outer encrypted message
      const stamped = {
        ...inner,
        seq: msg.seq,
        channel: (msg as any).channel,
        deviceId: (msg as any).deviceId,
        timestamp: (msg as any).timestamp,
      };

      // Process the decrypted inner message
      callbacks.handleDataMessage(stamped as Message);
      callbacks.getHandlers().forEach((h) => h(stamped as Message));
    } catch (err) {
      // Permanent decryption failure — show in-session error but still advance seq
      // (retrying won't help — the ciphertext is corrupted or keys mismatched)
      if (msg.seq && typeof msg.seq === 'number') {
        callbacks.updateSeq(msg.seq);
      }
      console.error('[Kraki] E2E decryption failed:', err);
      const sid = msg.sessionId as string | undefined;
      if (sid) {
        store.appendMessage(sid, {
          type: 'error',
          sessionId: sid,
          deviceId: '',
          seq: msg.seq ?? 0,
          channel: '',
          timestamp: (msg as any).timestamp ?? new Date().toISOString(),
          payload: { message: 'Failed to decrypt a message. The content could not be recovered.' },
        } as any);
      }
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
