import type { Message, InnerMessage } from '@kraki/protocol';
import { createAppKeyStore } from './e2e';
import { KrakiTransport, type MessageHandler } from './transport';
import { EncryptionHandler } from './encryption';
import { markSessionRead } from './replay';
import { sendAuth, handleAuthChallenge, processAuthOk, processAuthError } from './auth';
import { handleDataMessage } from './message-router';
import { getStore } from './store-adapter';
import { CommandState } from './commands';
import * as commands from './commands';

export class KrakiWSClient {
  private transport: KrakiTransport;
  private encryption: EncryptionHandler;
  private cmdState = new CommandState();
  private handlers: MessageHandler[] = [];

  get url(): string { return this.transport.url; }

  constructor(url?: string) {
    const keyStore = createAppKeyStore();
    this.encryption = new EncryptionHandler(keyStore);

    // Visibility change listener removed — replay is now handled by tentacle,
    // not the relay. Tab focus/blur doesn't trigger relay-side replay anymore.
    this.transport = new KrakiTransport(
      {
        onOpen: () => this.authenticate(),
        onParsedMessage: (msg) => {
          this.handleMessage(msg);
          this.handlers.forEach((h) => h(msg));
        },
        onClose: () => { /* no-op — thin relay has no server-side replay state to reset */ },
      },
      url,
    );
  }

  connect() {
    // Initialize key store (async, but we start connecting in parallel)
    if (!this.encryption.keyStore.isReady()) {
      this.encryption.keyStore.init().catch(() => {
        // Key init failed — E2E will not work
      });
    }
    this.transport.connect();
  }

  disconnect() {
    this.transport.disconnect();
  }

  send(msg: Record<string, unknown>) {
    this.transport.send(msg);
  }

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  // --- Actions ---

  /** Send through encryption layer as UnicastEnvelope. */
  private sendEncrypted(msg: Record<string, unknown>) {
    this.encryption.encryptOutbound(msg, (m) => this.transport.send(m));
  }

  sendInput(sessionId: string, text: string) {
    commands.sendInput(sessionId, text, (msg) => this.sendEncrypted(msg));
  }

  approve(permissionId: string, sessionId: string) {
    commands.approve(permissionId, sessionId, (msg) => this.sendEncrypted(msg));
  }

  deny(permissionId: string, sessionId: string) {
    commands.deny(permissionId, sessionId, (msg) => this.sendEncrypted(msg));
  }

  alwaysAllow(permissionId: string, sessionId: string, toolKind?: string) {
    commands.alwaysAllow(permissionId, sessionId, (msg) => this.sendEncrypted(msg), toolKind);
  }

  answer(questionId: string, sessionId: string, answerText: string) {
    commands.answer(questionId, sessionId, answerText, (msg) => this.sendEncrypted(msg));
  }

  killSession(sessionId: string) {
    commands.killSession(sessionId, (msg) => this.sendEncrypted(msg));
  }

  abortSession(sessionId: string) {
    commands.abortSession(sessionId, (msg) => this.sendEncrypted(msg));
  }

  setSessionMode(sessionId: string, mode: 'ask' | 'auto') {
    commands.setSessionMode(sessionId, mode, (msg) => this.sendEncrypted(msg));
  }

  deleteSession(sessionId: string) {
    // delete_session is now an encrypted unicast to the tentacle
    this.sendEncrypted({
      type: 'delete_session',
      sessionId,
      payload: {},
    });
  }

  createSession(opts: { targetDeviceId: string; model: string; prompt?: string; cwd?: string }) {
    commands.createSession(opts, (msg) => this.sendEncrypted(msg), this.cmdState);
  }

  markRead(sessionId: string): void {
    // Local-only in thin relay — no relay message needed
    markSessionRead(sessionId);
  }

  // --- Internal ---

  private async authenticate(): Promise<void> {
    const hasCredentials = this.transport.pairingToken || this.transport.storedDeviceId || this.transport.githubCode;

    if (!hasCredentials) {
      // No credentials — query server capabilities so the UI can show login options
      this.transport.send({ type: 'auth_info' });
      return;
    }

    const usedToken = await sendAuth(
      (msg) => this.transport.send(msg),
      this.encryption.keyStore,
      this.transport.pairingToken,
      this.transport.storedDeviceId,
      this.transport.githubCode,
    );
    if (usedToken) {
      this.transport.pairingToken = undefined;
    }
    if (this.transport.githubCode) {
      this.transport.githubCode = undefined;
    }
  }

  private encryptionCallbacks() {
    return {
      handleDataMessage: (msg: InnerMessage) => handleDataMessage(msg, {
        replaying: false,
        cmdState: this.cmdState,
        sendEncrypted: (m) => this.sendEncrypted(m),
      }),
      getHandlers: () => this.handlers,
    };
  }

  private handleMessage(msg: Message) {
    // Handle pong (keepalive response) — not in typed Message union
    if ((msg as any).type === 'pong') return;

    switch (msg.type) {
      // --- Encrypted envelopes ---
      case 'unicast':
      case 'broadcast':
        this.encryption.handleEncrypted(msg as any, this.encryptionCallbacks());
        return;

      // --- Control messages ---
      case 'auth_ok':
        processAuthOk(msg, this.transport.url, {
          setStoredDeviceId: (id) => { this.transport.storedDeviceId = id; },
          drainEncryptedQueue: () => this.encryption.drainEncryptedQueue(this.encryptionCallbacks()),
        });
        break;

      case 'auth_challenge':
        handleAuthChallenge(
          (msg as any).nonce,
          this.encryption.keyStore,
          this.transport.storedDeviceId,
          (m) => this.transport.send(m),
        );
        break;

      case 'auth_error':
        processAuthError(this.transport.storedDeviceId, {
          clearStoredDeviceId: () => { this.transport.storedDeviceId = undefined; },
          disconnect: () => this.disconnect(),
          connect: () => this.connect(),
        });
        break;

      case 'auth_info_response': {
        const info = msg as any;
        if (info.githubClientId) {
          getStore().setGithubClientId(info.githubClientId);
        }
        getStore().setStatus('awaiting_login');
        break;
      }

      case 'server_error': {
        const serverErr = msg as any;
        console.error('[Kraki] Server error:', serverErr.message);
        if (serverErr.requestId) {
          this.cmdState.clearRequest(serverErr.requestId);
        }
        getStore().setLastError(serverErr.message);
        break;
      }

      default:
        break;
    }
  }
}

// Singleton
export const wsClient = new KrakiWSClient();
