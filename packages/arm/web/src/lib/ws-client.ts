import type { InnerMessage, SessionListMessage, AuthOkMessage, AuthInfoResponse, ServerErrorMessage, AuthChallengeMessage, DeviceJoinedMessage, DeviceLeftMessage, RelayEnvelope, Message } from '@kraki/protocol';
import { createAppKeyStore } from './e2e';
import { KrakiTransport, type MessageHandler } from './transport';
import { EncryptionHandler } from './encryption';
import { markSessionRead } from './replay';
import { sendAuth, handleAuthChallenge, processAuthOk, processAuthError } from './auth';
import { handleDataMessage } from './message-router';
import { getStore, setStoreState } from './store-adapter';
import { messageProvider } from './message-provider';
import { CommandState } from './commands';
import * as commands from './commands';
import { createLogger, setLogBroadcast } from './logger';

const logger = createLogger('ws-client');

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
  sendEncrypted(msg: Record<string, unknown>) {
    this.encryption.encryptOutbound(msg, (m) => this.transport.send(m));
  }

  /** Send through encryption layer as BroadcastEnvelope to all devices. */
  sendBroadcast(msg: Record<string, unknown>) {
    this.encryption.encryptOutbound(msg, (m) => this.transport.send(m), { broadcast: true });
  }

  sendInput(sessionId: string, text: string, attachments?: import('@kraki/protocol').Attachment[]) {
    commands.sendInput(sessionId, text, (msg) => this.sendEncrypted(msg), attachments);
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

  setSessionMode(sessionId: string, mode: 'safe' | 'discuss' | 'execute' | 'delegate') {
    commands.setSessionMode(sessionId, mode, (msg) => this.sendEncrypted(msg), this.cmdState);
  }

  setSessionModel(sessionId: string, model: string, reasoningEffort?: string) {
    commands.setSessionModel(sessionId, model, (msg) => this.sendEncrypted(msg), reasoningEffort);
  }

  deleteSession(sessionId: string) {
    // Check if we can reach the tentacle before removing local state
    const session = getStore().sessions.get(sessionId);
    const deviceId = session?.deviceId;
    const device = deviceId ? getStore().devices.get(deviceId) : undefined;
    const hasKey = !!(device?.encryptionKey ?? device?.publicKey);
    if (hasKey) {
      this.sendEncrypted({
        type: 'delete_session',
        sessionId,
        payload: {},
      });
    }
    // Always remove locally — if device is unreachable, session_list
    // will reconcile when the tentacle comes back online
    getStore().removeSession(sessionId);
  }

  createSession(opts: { targetDeviceId: string; model: string; reasoningEffort?: string; prompt?: string; cwd?: string }) {
    commands.createSession(opts, (msg) => this.sendEncrypted(msg), this.cmdState);
  }

  forkSession(sourceSessionId: string) {
    commands.forkSession(sourceSessionId, (msg) => this.sendEncrypted(msg), this.cmdState);
  }

  renameSession(sessionId: string, title: string) {
    commands.renameSession(sessionId, title, (msg) => this.sendEncrypted(msg));
  }

  pinSession(sessionId: string, pinned: boolean) {
    commands.pinSession(sessionId, pinned, (msg) => this.sendEncrypted(msg));
  }

  markRead(sessionId: string, seq?: number): void {
    markSessionRead(sessionId);
    // Send to tentacle so it persists readSeq and broadcasts to other arms
    const resolvedSeq = seq ?? this.getLastSeq(sessionId);
    if (resolvedSeq > 0) {
      this.sendEncrypted({
        type: 'mark_read',
        sessionId,
        payload: { seq: resolvedSeq },
      });
    }
  }

  markUnread(sessionId: string): void {
    getStore().incrementUnread(sessionId);
    this.sendEncrypted({
      type: 'mark_unread',
      sessionId,
      payload: {},
    });
  }

  private getLastSeq(sessionId: string): number {
    const msgs = getStore().messages.get(sessionId);
    if (!msgs || msgs.length === 0) return 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const seq = 'seq' in m ? (m as { seq?: number }).seq : undefined;
      if (typeof seq === 'number' && seq > 0) return seq;
    }
    return 0;
  }

  /**
   * Handle session_list from tentacle: update metadata, trigger initial loads via provider.
   */
  // TODO: Batch store updates — currently each session triggers individual Zustand set() calls,
  // causing N re-renders on reconnect. Build maps first, then set() once.
  private handleSessionList(msg: SessionListMessage): void {
    const store = getStore();
    const tentacleSessions = msg.payload?.sessions ?? [];
    const tentacleDeviceId = msg.deviceId;
    const tentacleIds = new Set(tentacleSessions.map(s => s.id));

    logger.info('session_list received', { tentacleDeviceId, sessionCount: tentacleSessions.length });

    // Remove local sessions from this tentacle that are no longer in the list
    for (const [sid, session] of store.sessions) {
      if (session.deviceId === tentacleDeviceId && !tentacleIds.has(sid)) {
        store.removeSession(sid);
      }
    }

    // Update session metadata and trigger initial loads
    const pinnedFromTentacle = new Set<string>();
    for (const ts of tentacleSessions) {
      const currentStore = getStore();
      const device = currentStore.devices.get(tentacleDeviceId);
      store.upsertSession({
        id: ts.id,
        deviceId: tentacleDeviceId,
        deviceName: device?.name ?? tentacleDeviceId,
        agent: ts.agent,
        model: ts.model,
        title: ts.title,
        autoTitle: ts.autoTitle,
        state: ts.state as 'active' | 'idle',
        messageCount: ts.messageCount,
      });

      if (ts.mode) {
        store.setSessionMode(ts.id, ts.mode as 'safe' | 'discuss' | 'execute' | 'delegate');
      }

      // Restore cumulative usage from tentacle
      const tsRecord = ts as Record<string, unknown>;
      if (tsRecord.usage && typeof tsRecord.usage === 'object') {
        store.setSessionUsage(ts.id, tsRecord.usage as import('@kraki/protocol').SessionUsage);
      }

      // Sync pin state from tentacle
      if (ts.pinned) {
        pinnedFromTentacle.add(ts.id);
      }

      // Reconstruct unread badge from readSeq vs lastSeq (binary: 0 or 1)
      if (ts.lastSeq > (ts.readSeq ?? 0)) {
        if (!store.unreadCount.get(ts.id)) {
          store.incrementUnread(ts.id);
        }
      } else {
        store.clearUnread(ts.id);
      }

      // Store tentacle info and request latest messages via provider
      messageProvider.setTentacleInfo(ts.id, ts.lastSeq, tentacleDeviceId);
      messageProvider.requestLatest(ts.id);
    }

    // Apply pin state from tentacle (replaces local pins for this tentacle's sessions)
    const currentPinned = new Set(store.pinnedSessions);
    // Remove pins for sessions owned by this tentacle, then add back the ones tentacle says are pinned
    for (const sid of tentacleIds) {
      currentPinned.delete(sid);
    }
    for (const sid of pinnedFromTentacle) {
      currentPinned.add(sid);
    }
    store.setPinnedSessions(currentPinned);
  }

  /** Clear all in-progress tracking (used on disconnect/close). */
  private clearReplayTracking(): void {
    messageProvider.clear();
  }

  /**
   * Handle a replay batch — delegate to message provider.
   */
  private handleReplayBatch(msg: import('@kraki/protocol').SessionReplayBatchMessage): void {
    const { sessionId, messages, lastSeq, totalLastSeq } = msg.payload;
    if (!sessionId) return;
    messageProvider.handleBatch(sessionId, messages, lastSeq, totalLastSeq);
  }

  // --- Internal ---

  private async authenticate(): Promise<void> {
    const hasCredentials = this.transport.pairingToken || this.transport.storedDeviceId || this.transport.githubCode;

    if (!hasCredentials) {
      // No credentials — query server capabilities so the UI can show login options
      this.transport.sendRaw({ type: 'auth_info' });
      return;
    }

    const usedToken = await sendAuth(
      (msg) => this.transport.sendRaw(msg),
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
        cmdState: this.cmdState,
        sendEncrypted: (m) => this.sendEncrypted(m),
        onSessionList: (m) => this.handleSessionList(m),
        onSessionReplayBatch: (m) => this.handleReplayBatch(m),
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
        this.transport.setAuthenticated(true);
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
          (m) => this.transport.sendRaw(m),
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
        if (info.vapidPublicKey) {
          getStore().setVapidPublicKey(info.vapidPublicKey);
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
          getStore().setDeviceOnline(left.deviceId, false);
        }
        break;
      }

      case 'device_removed': {
        const removed = msg as { deviceId: string };
        if (removed.deviceId) {
          getStore().setDeviceModels(removed.deviceId, []);
          getStore().removeDevice(removed.deviceId);
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

// Wire message provider's send function
messageProvider.setSend((msg) => wsClient.sendEncrypted(msg));
