import type { InnerMessage, SessionListMessage, AuthOkMessage, AuthInfoResponse, ServerErrorMessage, AuthChallengeMessage, DeviceJoinedMessage, DeviceLeftMessage, RelayEnvelope, Message } from '@kraki/protocol';
import { createAppKeyStore } from './e2e';
import { KrakiTransport, type MessageHandler } from './transport';
import { EncryptionHandler } from './encryption';
import { markSessionRead } from './replay';
import { sendAuth, handleAuthChallenge, processAuthOk, processAuthError } from './auth';
import { handleDataMessage } from './message-router';
import { getStore, setStoreState } from './store-adapter';
import { CommandState } from './commands';
import * as commands from './commands';
import { createLogger, setLogBroadcast } from './logger';

const logger = createLogger('ws-client');

export class KrakiWSClient {
  private transport: KrakiTransport;
  private encryption: EncryptionHandler;
  private cmdState = new CommandState();
  private handlers: MessageHandler[] = [];
  /** Sessions currently being replayed — suppresses unread increments. */
  private replayingSessions = new Set<string>();

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
        onClose: () => { this.clearReplayTracking(); },
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
    this.clearReplayTracking();
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

  /** Send through encryption layer as BroadcastEnvelope to all devices. */
  sendBroadcast(msg: Record<string, unknown>) {
    this.encryption.encryptOutbound(msg, (m) => this.transport.send(m), { broadcast: true });
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

  setSessionMode(sessionId: string, mode: 'safe' | 'plan' | 'execute' | 'delegate') {
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

  /**
   * Handle session_list from tentacle: diff with local store, request per-session replays.
   */
  private handleSessionList(msg: SessionListMessage): void {
    const store = getStore();
    const tentacleSessions = msg.payload?.sessions ?? [];

    const tentacleDeviceId = msg.deviceId;
    const tentacleIds = new Set(tentacleSessions.map(s => s.id));

    logger.info('session_list received', { tentacleDeviceId, sessionCount: tentacleSessions.length, sessions: tentacleSessions.map(s => ({ id: s.id, lastSeq: s.lastSeq, messageCount: s.messageCount })) });

    // Remove local sessions from this tentacle that are no longer in the list
    for (const [sid, session] of store.sessions) {
      if (session.deviceId === tentacleDeviceId && !tentacleIds.has(sid)) {
        store.removeSession(sid);
      }
    }

    // Add/update sessions and request replays for stale ones
    for (const ts of tentacleSessions) {
      const currentStore = getStore();
      const device = currentStore.devices.get(tentacleDeviceId);
      store.upsertSession({
        id: ts.id,
        deviceId: tentacleDeviceId,
        deviceName: device?.name ?? tentacleDeviceId,
        agent: ts.agent,
        model: ts.model,
        state: ts.state as 'active' | 'idle',
        messageCount: ts.messageCount,
      });

      // Sync session mode from tentacle
      if (ts.mode) {
        store.setSessionMode(ts.id, ts.mode as 'safe' | 'plan' | 'execute' | 'delegate');
      }

      // Determine local freshness for this session
      const localMessages = currentStore.messages.get(ts.id);
      let localLastSeq = 0;
      if (localMessages) {
        for (const m of localMessages) {
          const seq = 'seq' in m ? (m as { seq?: number }).seq : undefined;
          if (typeof seq === 'number' && seq > localLastSeq) localLastSeq = seq;
        }
      }

      // Request replay if tentacle has newer messages than our local cache.
      // If localLastSeq > tentacle lastSeq, local data has stale seq numbers
      // (e.g. from before per-session seq migration) — clear and replay from scratch.
      if (localLastSeq > ts.lastSeq) {
        logger.info('session sync', { sessionId: ts.id, localLastSeq, tentacleLastSeq: ts.lastSeq, localCount: localMessages?.length ?? 0, staleCache: true });
        // Clear stale messages through the store (ensures persistence update)
        const cleaned = new Map(currentStore.messages);
        cleaned.delete(ts.id);
        setStoreState({ messages: cleaned });
        this.requestSessionReplay(tentacleDeviceId, ts.id, 0);
      } else if (localLastSeq < ts.lastSeq) {
        logger.info('session sync', { sessionId: ts.id, localLastSeq, tentacleLastSeq: ts.lastSeq, localCount: localMessages?.length ?? 0, needsReplay: true });
        this.requestSessionReplay(tentacleDeviceId, ts.id, localLastSeq);
      } else {
        logger.info('session sync', { sessionId: ts.id, localLastSeq, tentacleLastSeq: ts.lastSeq, localCount: localMessages?.length ?? 0, upToDate: true });
      }
    }
  }

  /** Clear all in-progress replay tracking (used on disconnect/close). */
  private clearReplayTracking(): void {
    this.replayingSessions.clear();
  }

  /**
   * Request replay for a specific session from a tentacle.
   */
  private requestSessionReplay(tentacleDeviceId: string, sessionId: string, afterSeq: number): void {
    const store = getStore();
    this.replayingSessions.add(sessionId);

    this.sendEncrypted({
      type: 'request_session_replay',
      deviceId: store.deviceId ?? '',
      payload: { sessionId, afterSeq, targetDeviceId: tentacleDeviceId },
    });

    // Safety timeout
    setTimeout(() => { this.replayingSessions.delete(sessionId); }, 10_000);
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
        replayingSessions: this.replayingSessions,
        cmdState: this.cmdState,
        sendEncrypted: (m) => this.sendEncrypted(m),
        onSessionList: (m) => this.handleSessionList(m),
        onSessionReplayComplete: (sessionId) => { this.replayingSessions.delete(sessionId); },
      }),
      getHandlers: () => this.handlers,
    };
  }

  private handleMessage(msg: Message) {
    // Handle pong (keepalive response) — not in typed Message union
    if ((msg as Record<string, unknown>).type === 'pong') return;

    switch (msg.type) {
      // --- Encrypted envelopes ---
      case 'unicast':
      case 'broadcast':
        this.encryption.handleEncrypted(msg as RelayEnvelope, this.encryptionCallbacks());
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
          (msg as AuthChallengeMessage).nonce,
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
        const info = msg as AuthInfoResponse;
        if (info.githubClientId) {
          getStore().setGithubClientId(info.githubClientId);
        }
        getStore().setReconnectState(0, null);
        getStore().setStatus('awaiting_login');
        break;
      }

      case 'server_error': {
        const serverErr = msg as ServerErrorMessage;
        logger.error('Server error:', serverErr.message);
        const ref = serverErr.ref;
        if (ref) {
          this.cmdState.clearRequest(ref);
        }
        getStore().setLastError(serverErr.message);
        break;
      }

      case 'device_joined': {
        const joined = msg as DeviceJoinedMessage;
        if (joined.device) {
          getStore().upsertDevice(joined.device);
        }
        break;
      }

      case 'device_left': {
        const left = msg as DeviceLeftMessage;
        if (left.deviceId) {
          getStore().setDeviceModels(left.deviceId, []);
          getStore().removeDevice(left.deviceId);
        }
        break;
      }

      default:
        break;
    }
  }
}

// Singleton
export const wsClient = new KrakiWSClient();

// Wire up remote log shipping
setLogBroadcast((msg) => wsClient.sendBroadcast(msg));
