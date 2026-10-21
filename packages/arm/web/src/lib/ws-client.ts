import { t } from '../i18n';
import * as voice from './voice/voice';
import { useAccountDeletion, DELETION_TIMEOUT_MS } from './account-deletion';
import { canRefreshUsage } from './usage';
import { desktop, desktopCredentials, setDesktopSignedOut } from './desktop';
import { presentDesktopPreview } from './desktop-notifications';
import type { ContentRef, InnerMessage, SessionListMessage, SessionSubscriptionSetMessage, AuthOkMessage, AuthInfoResponse, ServerErrorMessage, AuthChallengeMessage, DeviceJoinedMessage, DeviceLeftMessage, DeviceRenamedMessage, RelayEnvelope, Message, SessionState } from '@kraki/protocol';
import { outbox } from './chat/outbox';
import { HEAD_PULSE_TARGET, PAYLOAD_FRAGMENT_FEATURE, PayloadAssembler, isPayloadFragment, normalizeSessionMode, type SessionMode } from '@kraki/protocol';
import { createAppKeyStore } from './e2e';
import { KrakiTransport, STORAGE_KEY, type MessageHandler } from './transport';
import { EncryptionHandler } from './encryption';
import { markSessionRead } from './replay';
import { sendAuth, handleAuthChallenge, processAuthOk, processAuthError, applyPreferences } from './auth';
import { handleDataMessage } from './message-router';
import { getStore, setStoreState } from './store-adapter';
import { messageProvider } from './message-provider';
import { CommandState } from './commands';
import { allowAutoRead, isAutoReadSuppressed, suppressAutoRead } from './read-visibility';
import * as commands from './commands';
import { createLogger, setLogBroadcast } from './logger';
import { OrderedCrypto } from './ordered-crypto';
import { ArmPulse } from './arm-pulse';
import { LocalLinkClient, REPLAYABLE_ACROSS_ROUTES, STALE_ROUTE_DROPPED } from './local-link';
import { diag } from './diag';
import { traceEvent } from './trace';
import { SessionSubscriptionController } from './session-subscription';
import { failAttachment } from './attachments';
import { AttachmentPullQueue } from './attachment-pull-queue';
import { ForegroundActivity } from './foreground-activity';

const logger = createLogger('ws-client');


/** No frame for longer than a ping round (10 s + slack) → the link is not
 *  presumed live for outbox confirmation timing. */
const LIVE_LINK_QUIET_MS = 12_000;
/** Payload delivered this recently → data is still flowing, and an echo may
 *  be queued behind it (head-of-line on a slow or lossy link, where TCP
 *  retransmission backoff alone leaves multi-second gaps): not a stall.
 *  Same window as the native apps (`CommandSender.busyLinkWindow`). */
const DELIVERY_FLOWING_MS = 30_000;

/** Commands that act on whatever is running when the Tentacle receives them
 *  (Stop has no turn id). An unacknowledged one must die with its Head
 *  connection rather than be retransmitted after reconnect, where it would
 *  abort a successor turn. Same contract as native `connectionScoped`. */
export const CONNECTION_SCOPED = new Set(['abort_session']);

/** Highest durable seq held locally for a session (performance data only). */
function localHighestSeq(sessionId: string): number {
  let max = 0;
  for (const m of getStore().messages.get(sessionId) ?? []) {
    const seq = (m as { seq?: unknown }).seq;
    if (typeof seq === 'number' && Number.isInteger(seq) && seq > max) max = seq;
  }
  return max;
}

export class KrakiWSClient {
  private transport: KrakiTransport;
  private encryption: EncryptionHandler;
  private inboundCrypto = new OrderedCrypto();
  private outboundCrypto = new OrderedCrypto();
  private identityEpoch = 0;
  private headEpoch = 0;
  private routeEpochs = new Map<string, number>();
  private routeChanges = 0;
  private encryptedQueue: Array<Parameters<EncryptionHandler['handleEncrypted']>[0]> = [];
  private peerEpochs = new Map<string, number>();
  private cmdState = new CommandState();
  private handlers: MessageHandler[] = [];
  private pulse: ArmPulse;
  /** Bumped on every Head socket close; scopes CONNECTION_SCOPED sends. */
  private connectionEpoch = 0;
  private subscription: SessionSubscriptionController;
  /** Desktop shell only: direct loopback route to the Tentacle on this machine. */
  readonly localLink: LocalLinkClient | null;
  private pulseTick: ReturnType<typeof setInterval> | null = null;
  private foregroundActivity = new ForegroundActivity(() => {
    this.transport.sendRaw({ type: 'ping', foreground: true });
  });
  /** Reassembles payloads a Tentacle split into small parts (so a large
   *  message never looks like a dead link on a slow network). */
  private assembler = new PayloadAssembler();
  /** Features each Tentacle advertised in its greeting. */
  private deviceFeatures = new Map<string, Set<string>>();
  /** Last time pulse delivered anything (a whole payload or a fragment). */
  private lastDeliveryAt = 0;
  private attachmentPulls = new AttachmentPullQueue(({ sessionId, id, index }) => {
    if (getStore().status !== 'connected' && !this.localLink?.isLinked(getStore().sessions.get(sessionId)?.deviceId)) return false;
    const deviceId = getStore().deviceId;
    this.sendEncrypted({
      type: 'request_attachment',
      deviceId,
      sessionId,
      payload: { id, sessionId, mode: 'paced', index },
    });
    return true;
  }, {
    onRetry: (sessionId, ref, index, attempt) => {
      logger.warn('attachment chunk timed out — retrying', { sessionId, id: ref.id, index, attempt });
    },
    onFailure: (_sessionId, ref, reason) => failAttachment(ref, reason),
  });

  get url(): string { return this.transport.url; }

  /** Pair with a scanned QR code URL. */
  pairWithToken(relay: string, token: string) {
    this.transport.pairWithToken(relay, token);
  }

  /** Ask the relay to delete the account (relay control, not E2E). */
  requestAccountDeletion(): void {
    const del = useAccountDeletion.getState();
    if (getStore().status !== 'connected') {
      del.set({ kind: 'failed', message: t('app:errors.connectFirst') });
      return;
    }
    const attempt = Date.now();
    del.set({ kind: 'deleting', attempt });
    this.transport.sendRaw({ type: 'delete_account' });
    setTimeout(() => {
      const now = useAccountDeletion.getState().state;
      if (now.kind === 'deleting' && now.attempt === attempt) {
        useAccountDeletion.getState().set({ kind: 'failed', message: t('app:errors.noAnswer') });
      }
    }, DELETION_TIMEOUT_MS);
  }

  /** The relay deleted this account (asked from here or another device): sign out for good. */
  private accountWasDeleted(): void {
    diag.phase('logout');
    const savedClientId = getStore().githubClientId;
    localStorage.removeItem(STORAGE_KEY);
    this.transport.storedDeviceId = undefined;
    this.disconnect();
    // Kraki for Windows: the built-in Kraki forgets its own sign-in and stops;
    // drop its login item and ownership so setup starts from the beginning.
    if (window.krakiDesktop?.builtIn) {
      void window.krakiDesktop.builtIn.disable();
      for (const k of ['kraki-desktop.role', 'kraki-desktop.owner', 'kraki-desktop.movedFromCLI']) localStorage.removeItem(k);
      setDesktopSignedOut(false);
    }
    getStore().reset();
    voice.resetVoice();
    setStoreState({ githubClientId: savedClientId, status: 'awaiting_login' });
    useAccountDeletion.getState().set({ kind: 'idle' });
    useAccountDeletion.getState().setNotice(true);
    window.history.replaceState({}, '', '/');
  }

  /** Connect with the account of the Kraki built into the desktop app. */
  connectWithDesktopCredentials(): boolean {
    setDesktopSignedOut(false);
    const creds = desktopCredentials();
    if (!creds) return false;
    getStore().setStatus('connecting');
    this.transport.redirectToRelay(creds.relay);
    return true;
  }

  constructor(url?: string) {
    voice.configureVoiceTransport({
      sendRaw: (m) => this.transport.sendRaw(m),
      deviceId: () => getStore().deviceId,
      userId: () => getStore().user?.id ?? null,
      relayUrl: () => this.transport.url,
      connected: () => getStore().status === 'connected',
    });
    outbox.configure({
      send: (msg) => this.transmit(msg),
      isDeliveryPathUp: (sessionId) => this.isDeliveryPathUp(sessionId),
      isLinkBusy: () => Date.now() - this.lastDeliveryAt < DELIVERY_FLOWING_MS,
      acceptsResend: (sessionId) => this.acceptsResend(sessionId),
      getSpineHead: (sessionId) => (getStore().messages.get(sessionId) ?? []).reduce(
        (head, m) => Math.max(head, 'seq' in m ? m.seq ?? 0 : 0), getStore().sessions.get(sessionId)?.lastSeq ?? 0),
      placeCardAboveSteer: (sessionId, clientId) => getStore().placeCardAboveSteer(sessionId, clientId),
      isTurnRunning: (sessionId) => getStore().sessions.get(sessionId)?.state === 'active'
        || getStore().runtimeStatuses.get(sessionId)?.status === 'compacting',
    });
    const keyStore = createAppKeyStore();
    this.encryption = new EncryptionHandler(keyStore);
    this.subscription = new SessionSubscriptionController({
      isConnected: () => getStore().status === 'connected',
      resolveTentacle: (sessionId) => getStore().sessions.get(sessionId)?.deviceId,
      send: (tentacleId, sessionId, requestId) => this.sendSessionSubscription(tentacleId, sessionId, requestId),
      isRouteIndependent: (tentacleId) => this.localLink?.isLinked(tentacleId) === true,
      applySnapshot: (msg) => this.applySubscriptionSnapshot(msg),
      reportError: (message) => getStore().setLastError(message),
    });

    // Per-hop pulse endpoint to the relay — the reliable-delivery layer.
    this.pulse = new ArmPulse(
      {
        now: () => Date.now(),
        sendPulseFrame: (pulseB64, to) => this.sendPulseEnvelope(pulseB64, to),
        onDelivered: (blobB64, streamId) => this.handlePulseDelivered(blobB64, 'head', undefined, streamId),
        onAcked: (seqUpTo) => this.cmdState.resolvePulseAcked(seqUpTo),
        onResetInbound: () => this.assembler.clear(),
      },
      `arm:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    );

    this.localLink = desktop?.localLinkDiscovery ? new LocalLinkClient({
      readDiscovery: () => desktop!.localLinkDiscovery!(),
      appId: () => getStore().deviceId ?? null,
      tentacleKey: (tentacleId) => {
        const d = getStore().devices.get(tentacleId);
        return d?.role === 'tentacle' ? d.publicKey ?? undefined : undefined;
      },
      sign: (message) => this.encryption.keyStore.signChallenge(message),
      onLinkChange: (tentacleId, linked, unacked) => this.onLocalLinkChange(tentacleId, linked, unacked),
      onDelivered: (payloadJson, streamId) => this.handlePulseDelivered(payloadJson, 'link', undefined, streamId),
    }) : null;

    // Visibility change listener removed — replay is now handled by tentacle,
    // not the relay. Tab focus/blur doesn't trigger relay-side replay anymore.
    this.transport = new KrakiTransport(
      {
        onOpen: () => this.authenticate(),
        onParsedMessage: (msg) => {
          this.handleMessage(msg);
          this.handlers.forEach((h) => h(msg));
        },
        onClose: () => {
          this.connectionEpoch++;
          this.headEpoch++;
          this.encryptedQueue = [];
          this.inboundCrypto.clear((domain) => domain.startsWith('head:'));
          this.subscription.onDisconnected();
          this.outboundCrypto.clear((domain) => !this.localLink?.isLinked(JSON.parse(domain)[0]));
          this.clearReplayTracking();
          this.attachmentPulls.disconnect();
          this.pulse.onDisconnected();
        },
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
    this.identityEpoch++;
    this.encryptedQueue = [];
    this.inboundCrypto.clear();
    // stop() synchronously removes linked authority through onLocalLinkChange.
    // Explicit transport.disconnect suppresses onClose, so revoke the remaining
    // controller flight here before settling canceled send promises.
    this.localLink?.stop();
    this.subscription.onDisconnected();
    this.outboundCrypto.clear();
    this.peerEpochs.clear();
    this.routeEpochs.clear();
    this.routeChanges = 0;
    this.clearReplayTracking();
    this.transport.disconnect();
  }

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  setDesiredSession(sessionId: string | null): void {
    this.subscription.setDesired(sessionId);
  }

  isLiveReady(sessionId: string): boolean {
    return this.subscription.confirmed === sessionId;
  }

  private async sendSessionSubscription(tentacleId: string, sessionId: string | null, requestId?: string): Promise<boolean> {
    const deviceId = getStore().deviceId;
    if (!deviceId) return false;
    const msg = {
      type: 'set_session_subscription',
      deviceId,
      seq: 0,
      timestamp: new Date().toISOString(),
      payload: { sessionId, ...(requestId && { requestId }) },
    };
    return new Promise((resolve) => this.encryptOrdered(msg, tentacleId,
      () => this.encryption.encryptForDevice(msg, tentacleId), (encrypted) => {
        if (!encrypted) { resolve(false); return; }
        this.route(JSON.stringify({ blob: encrypted.blob, keys: encrypted.keys }), encrypted.to, false, false);
        resolve(true);
      }));
  }

  /** Snapshot identity and peer authority at admission, re-check at delivery.
   * Head connection loss invalidates pending sends, not Pulse's retained outbox.
   * Link route generations are filtered by message type after decrypt: ordinary
   * link loss is not identity/peer revocation for already-delivered responses. */
  private cryptoGuard(peer?: string, route?: 'head' | 'link'): (resolvedPeer?: string) => boolean {
    const epoch = this.identityEpoch;
    const headEpoch = this.headEpoch;
    const deviceId = getStore().deviceId;
    const userId = getStore().user?.id;
    const keyStore = this.encryption.keyStore;
    // Legacy envelopes may omit src: resolve their peer only AFTER decrypt,
    // comparing against admission-time authority rather than current identity.
    const epochs = peer ? null : new Map(this.peerEpochs);
    const keys = peer ? null : new Map([...getStore().devices].map(([id, device]) => [id, device.encryptionKey ?? device.publicKey]));
    const peerEpoch = peer ? this.peerEpochs.get(peer) : undefined;
    const key = peer ? getStore().devices.get(peer) : undefined;
    const publicKey = key?.encryptionKey ?? key?.publicKey;
    return (resolvedPeer) => {
      const target = peer ?? resolvedPeer;
      return epoch === this.identityEpoch && deviceId === getStore().deviceId
        && userId === getStore().user?.id && keyStore === this.encryption.keyStore && keyStore.isReady()
        && (route !== 'head' || headEpoch === this.headEpoch)
        && (!target || ((peer ? peerEpoch : epochs?.get(target)) === this.peerEpochs.get(target)
          && (peer ? publicKey : keys?.get(target)) === (getStore().devices.get(target)?.encryptionKey ?? getStore().devices.get(target)?.publicKey)));
    };
  }

  private targetFor(msg: Record<string, unknown>): string | undefined {
    return (msg.payload as { targetDeviceId?: string } | undefined)?.targetDeviceId
      ?? getStore().sessions.get(msg.sessionId as string)?.deviceId;
  }

  private encryptOrdered(
    msg: Record<string, unknown>, target: string | undefined,
    work: () => ReturnType<EncryptionHandler['encryptForTarget']>,
    deliver: (encrypted: Awaited<ReturnType<EncryptionHandler['encryptForTarget']>>) => void,
    canceled: () => void = () => deliver(null),
  ): void {
    const valid = this.cryptoGuard(target, this.localLink?.isLinked(target) ? 'link' : 'head');
    const linked = this.localLink?.isLinked(target) === true;
    this.outboundCrypto.run(JSON.stringify([target ?? null]), work, (encrypted) => {
      const sessionTarget = this.targetFor(msg);
      if (!valid() || linked !== (this.localLink?.isLinked(target) === true)
        || (sessionTarget && sessionTarget !== target)) { canceled(); return; }
      deliver(encrypted);
    }, canceled);
  }

  private applySubscriptionSnapshot(msg: SessionSubscriptionSetMessage): void {
    if (!msg.payload.accepted || msg.payload.sessionId === null) return;
    const { digest, spineHeadSeq, card } = msg.payload.snapshot;
    const store = getStore();
    const device = store.devices.get(msg.deviceId);
    const previousReadSeq = store.sessions.get(digest.id)?.readSeq;
    if (previousReadSeq !== undefined && digest.readSeq < previousReadSeq && digest.readSeq < digest.lastSeq) {
      suppressAutoRead(digest.id);
    } else if (digest.readSeq >= digest.lastSeq) {
      allowAutoRead(digest.id);
    }
    store.upsertSession({
      id: digest.id,
      deviceId: msg.deviceId,
      deviceName: device?.name ?? msg.deviceId,
      agent: digest.agent,
      model: digest.model,
      reasoningEffort: digest.reasoningEffort,
      createdAt: digest.createdAt,
      title: digest.title,
      autoTitle: digest.autoTitle,
      state: digest.state,
      messageCount: digest.messageCount,
      lastSeq: digest.lastSeq,
      readSeq: digest.readSeq,
    });
    store.setSessionMode(digest.id, normalizeSessionMode(digest.mode));
    if (digest.preview) store.setSessionPreview(digest.id, digest.preview);
    if (digest.usage) store.setSessionUsage(digest.id, digest.usage);
    store.holdCard(digest.id, spineHeadSeq);
    store.replaceCardFromSubscription(digest.id, { text: card.draft, action: card.action },
      digest.state === 'active' || digest.state === 'compacting');
    messageProvider.setTentacleInfo(digest.id, spineHeadSeq, msg.deviceId);
    messageProvider.reconcileTail(digest.id, spineHeadSeq);
  }

  // --- Actions ---

  /** Encrypt a consumer message to its target tentacle and send it over pulse.
   *  `onSeq`, if given, receives the pulse send seq (for optimistic-rollback
   *  tracking), or null when the target/key could not be resolved. */
  sendEncrypted(msg: Record<string, unknown>, onSeq?: (seq: bigint | null) => void) {
    // The Tentacle only learns the sender from inside the E2E payload (Head
    // forwards it opaque). Without it, it cannot address replies such as the
    // re-echo of a duplicate input, which then stays unconfirmed forever.
    if (msg.deviceId === undefined && getStore().deviceId) msg = { ...msg, deviceId: getStore().deviceId };
    const durable = msg.type === 'delete_session';
    // Stop belongs to the connection (and turn) it was clicked on; see
    // CONNECTION_SCOPED. Capture the connection now: encryption is async and
    // the socket may drop and come back before it resolves.
    const scoped = CONNECTION_SCOPED.has(msg.type as string);
    const epoch = this.connectionEpoch;
    const clientId = (msg.payload as { clientId?: string } | undefined)?.clientId;
    traceEvent({ comp: 'arm', evt: 'APP-SEND-ENCRYPTED', type: msg.type as string, sessionId: (msg as { sessionId?: string }).sessionId, clientId });
    this.encryptOrdered(msg, this.targetFor(msg), () => this.encryption.encryptForTarget(msg), (enc) => {
      if (!enc) {
        traceEvent({ comp: 'arm', evt: 'APP-ENCRYPT-FAIL', type: msg.type as string, clientId });
        getStore().setLastError(t('app:errors.noTarget'));
        onSeq?.(null);
        return;
      }
      traceEvent({ comp: 'arm', evt: 'APP-ENCRYPT-OK', type: msg.type as string, clientId, blobLen: enc.blob.length, to: enc.to });
      const seq = this.route(JSON.stringify({ blob: enc.blob, keys: enc.keys }), enc.to, durable,
        REPLAYABLE_ACROSS_ROUTES.has(msg.type as string), scoped ? epoch : undefined);
      if (seq === null) traceEvent({ comp: 'arm', evt: 'APP-SCOPED-DROPPED', type: msg.type as string, sessionId: (msg as { sessionId?: string }).sessionId });
      onSeq?.(seq);
    }, () => onSeq?.(null));
  }

  /** The Tentacle on this machine is reached over the local link; everything
   *  else over the Head. The ciphertext is the same either way. */
  private route(payloadJson: string, to: string, durable: boolean, replayable: boolean, scopedEpoch?: number): bigint | null {
    if (this.localLink?.isLinked(to) && this.localLink.send(payloadJson, to, replayable)) return 0n;
    if (scopedEpoch === undefined) return this.pulse.send(payloadJson, to, durable);
    // The Head connection it was issued on is gone: never carry it into a new one.
    if (scopedEpoch !== this.connectionEpoch) return null;
    return this.pulse.send(payloadJson, to, durable, { connectionScoped: true });
  }

  /** The route to `tentacleId` switched between the Head and the local link.
   *  Like a Tentacle (re)join: drop connection-scoped subscription authority
   *  (the Tentacle sends session_list on the new route, the new barrier) and
   *  re-ask the attachment chunk that was in flight on the old route. Commands
   *  the dead link accepted but never confirmed go out over the Head. The
   *  Tentacle's greeting on the new route re-sends unconfirmed inputs. */
  private onLocalLinkChange(tentacleId: string, linked: boolean, unacked: Array<{ payload: string; target: string }>): void {
    this.routeEpochs.set(tentacleId, (this.routeEpochs.get(tentacleId) ?? 0) + 1);
    this.routeChanges++;
    this.subscription.onTentacleAuthorityReset(tentacleId);
    this.outboundCrypto.clear((domain) => domain === JSON.stringify([tentacleId]));
    // Already-Pulse-delivered responses still own their old generation slots.
    // Fresh generations progress independently; completion filters stale live
    // types, while identity/peer revocation still cancels all affected work.
    traceEvent({ comp: 'arm', evt: 'LOCAL-LINK', tentacleId, linked, replay: unacked.length });
    this.attachmentPulls.disconnect();
    this.attachmentPulls.resume();
    for (const { payload, target } of unacked) this.pulse.send(payload, target, false);
    if (linked) getStore().setDeviceOnline(tentacleId, true);
  }

  /** Put a pulse frame on the wire as a unicast envelope to the tentacle via
   *  head: head reads `pulse` for transport + `to` for the forward destination.
   *  The payload ({blob,keys}) is inside the frame. */
  private sendPulseEnvelope(pulseB64: string, to: string) {
    traceEvent({ comp: 'arm', evt: 'WS-TX', type: 'unicast', to, pulseB64Len: pulseB64.length });
    this.transport.send({ type: 'unicast', to, pulse: pulseB64, blob: '', keys: {} });
  }

  /** A reliable message was delivered in order by pulse. Two shapes:
   *  - `{from:'@head', msg}` — PLAINTEXT head-originated control (presence,
   *    preferences_updated, voice). Head↔device has no E2E, so dispatch `msg`
   *    directly, no decrypt.
   *  - `{blob, keys}` — the E2E ciphertext from a tentacle; decrypt then dispatch. */
  private handlePulseDelivered(payloadJson: string, route: 'head' | 'link' = 'link', fragmentSender?: string, streamId = 0) {
    this.lastDeliveryAt = Date.now();
    let parsed: { from?: string; src?: string; msg?: InnerMessage; blob?: string; keys?: Record<string, string> };
    try {
      parsed = JSON.parse(payloadJson);
    } catch {
      return;
    }
    if (isPayloadFragment(parsed)) {
      const whole = this.assembler.accept(parsed);
      if (whole !== null) this.handlePulseDelivered(whole, route, (parsed as { src?: string }).src, streamId);
      return;
    }
    if (parsed.from === HEAD_PULSE_TARGET && parsed.msg) {
      const inner = parsed.msg as unknown as Message;
      traceEvent({ comp: 'arm', evt: 'APP-HEAD-CONTROL', type: (inner as { type?: string }).type });
      this.handleMessage(inner);
      this.handlers.forEach((h) => h(inner));
      return;
    }
    if (typeof parsed.blob === 'string' && parsed.keys) {
      const decryptStart = performance.now();
      // Through the Head from a Tentacle this App is linked to: sent before the
      // switch. Its live, connection-scoped state would land after the link's
      // fresh snapshot and duplicate or revert it; the rest still applies.
      const sender = parsed.src ?? fragmentSender;
      const valid = this.cryptoGuard(sender, route);
      const routeEpoch = sender ? this.routeEpochs.get(sender) : this.routeChanges;
      const domain = `${route}:${JSON.stringify(sender ?? null)}:${streamId}:${routeEpoch ?? 0}`;
      this.inboundCrypto.run(domain, () => this.encryption.decryptBlob(parsed.blob!, parsed.keys!), (inner) => {
        if (!inner || !valid(inner.deviceId)) return;
        const changedRoute = routeEpoch !== (sender ? this.routeEpochs.get(sender) : this.routeChanges);
        const staleRoute = changedRoute || (route === 'head' && this.localLink?.isLinked(sender ?? inner.deviceId) === true);
        if (staleRoute && STALE_ROUTE_DROPPED.has(inner.type)) {
          if (this.localLink) this.localLink.stats.staleHeadFrames++;
          return;
        }
        traceEvent({ comp: 'arm', evt: 'APP-DECRYPT', type: inner.type, sessionId: (inner as { sessionId?: string }).sessionId, clientId: (inner as { payload?: { clientId?: string } }).payload?.clientId, decryptMs: performance.now() - decryptStart });
        this.dispatchInner(inner);
      });
    }
  }

  /** Route a decrypted inner message through subscription gating and the normal pipeline. */
  private dispatchInner(inner: InnerMessage) {
    if (inner.type === 'local_notification') {
      presentDesktopPreview(inner.payload.preview);
      return;
    }
    if (inner.type === 'device_greeting') this.onTentacleGreeting(inner as unknown as { deviceId: string; payload?: { features?: unknown } });
    if (inner.type === 'session_subscription_set') {
      this.subscription.onAck(inner as SessionSubscriptionSetMessage);
      this.handlers.forEach((h) => h(inner as unknown as Message));
      return;
    }
    if (
      (inner.type === 'agent_message_delta' || inner.type === 'card_action')
      && (!inner.sessionId || !this.subscription.acceptsLive(inner.sessionId))
    ) {
      return;
    }
    handleDataMessage(inner, {
      cmdState: this.cmdState,
      sendEncrypted: (m) => this.sendEncrypted(m),
      onSessionList: (m) => this.handleSessionList(m),
      onSessionMessagesRangeBatch: (m) => this.handleRangeBatch(m),
      onAttachmentChunk: (chunk) => this.attachmentPulls.handleChunk(chunk),
    });
    this.handlers.forEach((h) => h(inner as unknown as Message));
  }

  /** Drive pulse heartbeat/liveness every 5s (finer than the 15s heartbeat). */
  private startPulseTick() {
    if (this.pulseTick) return;
    this.pulseTick = setInterval(() => this.pulse.tick(), 5000);
  }

  /** Send a head-terminated control message over pulse (reliable, non-durable).
   *  The payload is PLAINTEXT JSON (not {blob,keys}) — the head is the recipient,
   *  so there is no E2E on this hop. HEAD_PULSE_TARGET makes head consume it
   *  locally instead of forwarding, and marks the payload as plaintext control.
   *  Replaces the former raw `transport.send` for update_preferences /
   *  remove_device / (un)register_push_token. */
  private sendToHead(msg: Record<string, unknown>) {
    this.pulse.send(JSON.stringify(msg), HEAD_PULSE_TARGET, false);
  }

  /** Ship a client_log (debug telemetry) to each online tentacle over pulse —
   *  the tentacle writes the browser's logs to a local file. It has no session,
   *  so we fan it out per-tentacle (pulse is point-to-point): one reliable pulse
   *  send per online tentacle, each E2E-encrypted to that tentacle. No raw WS. */
  sendBroadcast(msg: Record<string, unknown>) {
    const store = getStore();
    // Name the sender: client_log lines were all "[undefined]", so different
    // browsers/devices could not be told apart in web-client.log.
    if (msg.deviceId === undefined && store.deviceId) msg = { ...msg, deviceId: store.deviceId };
    for (const dev of store.devices.values()) {
      if (dev.role !== 'tentacle' || !dev.online) continue;
      if (dev.id === store.deviceId) continue;
      // Stamp the target so encryptForTarget resolves this tentacle, then pulse.
      this.sendEncryptedTo(dev.id, msg);
    }
  }

  /** Encrypt `msg` for one specific device and send it over pulse (reliable,
   *  non-durable). Used for targetless-but-per-device fan-out (client_log). */
  private sendEncryptedTo(targetDeviceId: string, msg: Record<string, unknown>) {
    const stamped = { ...msg, payload: { ...(msg.payload as Record<string, unknown> ?? {}), targetDeviceId } };
    this.encryptOrdered(stamped, targetDeviceId, () => this.encryption.encryptForTarget(stamped), (enc) => {
      if (enc) this.pulse.send(JSON.stringify({ blob: enc.blob, keys: enc.keys }), enc.to, false);
    });
  }

  /** Send a message (optimistic bubble, delivery states — see `outbox`).
   *  Answering a question is sending a message with `answerTo`. */
  sendInput(
    sessionId: string,
    text: string,
    opts: { attachments?: import('@kraki/protocol').Attachment[]; delivery?: 'prompt' | 'steer'; answerTo?: string } = {},
  ): string {
    const clientId = outbox.send(sessionId, text, opts);
    getStore().setSessionPreview(sessionId, { text: text.slice(0, 80), type: 'user', timestamp: new Date().toISOString() });
    return clientId;
  }

  /** Hand a consumer message to transport; resolves false if it could not be
   *  encrypted/routed. */
  private transmit(msg: Record<string, unknown>): Promise<boolean> {
    return new Promise((resolve) => this.sendEncrypted(msg, (seq) => resolve(seq !== null)));
  }

  /** Relay connected and live (not silent past a ping round), and the
   *  session's device online: an input can go out now. */
  private isDeliveryPathUp(sessionId: string): boolean {
    const store = getStore();
    const deviceId = store.sessions.get(sessionId)?.deviceId;
    if (this.localLink?.isLinked(deviceId)) return true;
    if (store.status !== 'connected') return false;
    if (this.transport.msSinceLastRx() > LIVE_LINK_QUIET_MS) return false;
    return !!deviceId && store.devices.get(deviceId)?.online === true;
  }

  /** Whether the session's Tentacle deduplicates inputs by clientId, so an
   *  input whose fate is unknown may be sent again. `undefined` until it has
   *  greeted this page. */
  private acceptsResend(sessionId: string): boolean | undefined {
    const deviceId = getStore().sessions.get(sessionId)?.deviceId;
    const features = deviceId ? this.deviceFeatures.get(deviceId) : undefined;
    return features ? features.has('idempotent_input') : undefined;
  }

  private onTentacleGreeting(greeting: { deviceId: string; payload?: { features?: unknown } }) {
    const raw = greeting.payload?.features;
    // A greeting without `features` says nothing about them (some Tentacle
    // builds omit them from the broadcast after their own reconnect): keep
    // what this Tentacle already told us. Never seen any → an older Tentacle.
    const features = Array.isArray(raw)
      ? new Set(raw.filter((f): f is string => typeof f === 'string'))
      : this.deviceFeatures.get(greeting.deviceId) ?? new Set<string>();
    this.deviceFeatures.set(greeting.deviceId, features);
    if (features.has(PAYLOAD_FRAGMENT_FEATURE)) this.declareClientFeatures(greeting.deviceId);
    // The Tentacle (re)started or we (re)connected: whatever it had not
    // echoed may be lost. It deduplicates, so offer every unconfirmed input
    // again (older Tentacles: the outbox marks them for manual retry).
    outbox.resendUnconfirmed((sessionId) => getStore().sessions.get(sessionId)?.deviceId === greeting.deviceId);
  }

  /** Tell a Tentacle this app reassembles fragments. Needed again after the
   *  Tentacle reconnects: it forgets apps' features on every auth. */
  private declareClientFeatures(tentacleId: string) {
    this.sendEncrypted({
      type: 'client_features',
      deviceId: getStore().deviceId ?? '',
      seq: 0,
      timestamp: new Date().toISOString(),
      payload: { features: [PAYLOAD_FRAGMENT_FEATURE], targetDeviceId: tentacleId },
    });
  }

  /**
   * Request the bytes of an attachment from the tentacle that owns the session.
   * Used by `useAttachment` when an `ContentRef` arrives via replay
   * (rather than a live push) or when a push safety-timeout elapses.
   *
   * The message stamps:
   *   - deviceId at the inner level so the tentacle can address its chunked
   *     reply back to us (other consumer messages don't need this because they
   *     are addressed by sessionId, but our reply unicast requires the
   *     requester's pubkey lookup).
   *   - sessionId at the envelope level so encryption.encryptForTarget resolves
   *     the tentacle device that owns the session.
   *   - sessionId inside payload too, so the tentacle's AttachmentStore knows
   *     which session dir to read from.
   */
  requestAttachment(sessionId: string, ref: ContentRef) {
    this.attachmentPulls.request(sessionId, ref);
  }

  /** Resolve the live permission: the decision shows at once (read-only,
   *  "Sending…"); Tentacle's resolved card replaces it. Without confirmation
   *  while the delivery path is up it reverts with an explanation. */
  /** `onUndelivered` fires once if the decision could not be dispatched, or was
   *  not confirmed in time; the permission is actionable again by then. */
  resolvePermission(sessionId: string, permissionId: string, toolName: string | undefined,
                    decision: 'approve' | 'deny', reason?: string, onUndelivered?: () => void) {
    const store = getStore();
    const current = store.cards.get(sessionId)?.action;
    if (current?.type === 'permission' && current.payload.id === permissionId) {
      const shown = decision;
      store.setCardAction(sessionId, {
        ...current,
        payload: { ...current.payload, decision: shown, localPending: true, localError: undefined } as unknown as typeof current.payload,
      });
    }
    let settled = false;
    const rollback = (localError: string) => {
      const action = getStore().cards.get(sessionId)?.action;
      const stillLocal = action?.type === 'permission' && action.payload.id === permissionId
        && (action.payload as { localPending?: boolean }).localPending;
      if (!stillLocal || settled) return;
      settled = true;
      getStore().revertLocalPermission(sessionId, permissionId, localError);
      onUndelivered?.();
    };
    // Could not even be dispatched (no key/target): roll back at once, as
    // Mac CommandSender does, instead of waiting for the confirmation timeout.
    const send = (msg: Record<string, unknown>) => this.sendEncrypted(msg, (seq) => {
      if (seq === null) rollback(t('app:errors.permissionSend'));
    });
    if (decision === 'approve') {
      commands.approve(permissionId, sessionId, send);
    } else {
      commands.deny(permissionId, sessionId, send, reason);
    }
    const started = Date.now();
    const check = () => {
      const action = getStore().cards.get(sessionId)?.action;
      const stillLocal = action?.type === 'permission' && action.payload.id === permissionId
        && (action.payload as { localPending?: boolean }).localPending;
      if (!stillLocal || settled) return;
      if (Date.now() - started < 20_000 || !this.isDeliveryPathUp(sessionId)) { setTimeout(check, 2_000); return; }
      rollback(t('app:errors.permissionUnconfirmed'));
    };
    setTimeout(check, 2_000);
  }



  killSession(sessionId: string) {
    commands.killSession(sessionId, (msg) => this.sendEncrypted(msg));
  }

  /** `onRefused` fires if the Stop could not be dispatched on the current
   *  connection (no key/target, offline, or the connection dropped while it
   *  was being encrypted), so the UI can make Stop actionable again. */
  abortSession(sessionId: string, onRefused?: () => void) {
    commands.abortSession(sessionId, (msg) => this.sendEncrypted(msg, (seq) => { if (seq === null) onRefused?.(); }));
  }

  setSessionMode(sessionId: string, mode: SessionMode) {
    commands.setSessionMode(sessionId, mode, (msg) => this.sendEncrypted(msg), this.cmdState);
  }

  setSessionModel(sessionId: string, model: string, reasoningEffort?: string, contextTier?: string) {
    commands.setSessionModel(sessionId, model, (msg) => this.sendEncrypted(msg), reasoningEffort, contextTier);
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

  createSession(opts: { targetDeviceId: string; model: string; reasoningEffort?: string; contextTier?: string; prompt?: string; cwd?: string; agentId?: string }) {
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

  archiveSession(sessionId: string, archived: boolean) {
    commands.archiveSession(sessionId, archived, (msg) => this.sendEncrypted(msg));
  }

  /** True when the tentacle's greeting lists this feature. */
  deviceHasFeature(deviceId: string, feature: string): boolean | undefined {
    const f = this.deviceFeatures.get(deviceId);
    return f ? f.has(feature) : undefined;
  }

  /**
   * Ask tentacles for a fresh account usage reading (CommandSender
   * .refreshAccountUsage on Mac/iOS): online ones that support it, at most
   * once a minute each; provider cooldowns still apply on the tentacle.
   */
  refreshAccountUsage(opts: { automatic?: boolean; deviceIds?: string[] } = {}): number {
    const store = getStore();
    if (store.status !== 'connected') return 0;
    let sent = 0;
    for (const d of store.devices.values()) {
      if (d.role !== 'tentacle' || !d.online) continue;
      if (opts.deviceIds && !opts.deviceIds.includes(d.id)) continue;
      if (!this.deviceHasFeature(d.id, 'account_usage_refresh')) continue;
      if (!canRefreshUsage(store.usageRefreshes.get(d.id), store.deviceUsage.get(d.id), !!opts.automatic)) continue;
      const requestId = crypto.randomUUID();
      store.beginUsageRefresh(d.id, requestId);
      this.sendEncryptedTo(d.id, { type: 'refresh_account_usage', deviceId: store.deviceId ?? undefined, payload: { requestId } });
      setTimeout(() => getStore().finishUsageRefresh(d.id, requestId, 'timeout'), 120_000);
      sent++;
    }
    return sent;
  }

  requestArchivedSessions(targetDeviceId: string) {
    commands.requestArchivedSessions(targetDeviceId, (msg) => this.sendEncrypted(msg));
  }

  deleteArchivedSessions(targetDeviceId: string) {
    commands.deleteArchivedSessions(targetDeviceId, (msg) => this.sendEncrypted(msg));
    getStore().setArchivedSessions(targetDeviceId, []);
  }

  updateDevice(targetDeviceId: string, when?: 'now' | 'idle') {
    const store = getStore();
    const requestId = crypto.randomUUID();
    const info = store.deviceUpdates.get(targetDeviceId);
    store.setUpdateProgress(targetDeviceId, { phase: 'requested', requestId, from: info?.current, to: info?.latest, at: Date.now() });
    commands.updateDevice(targetDeviceId, requestId, when, (msg) => this.sendEncrypted(msg));
  }

  setAutoArchiveDays(targetDeviceId: string, days: number) {
    commands.setAutoArchiveDays(targetDeviceId, days, (msg) => this.sendEncrypted(msg));
  }

  /**
   * Open an archived session: restore it on its computer and show it now.
   * The computer's next session_list confirms it.
   */
  openArchivedSession(deviceId: string, digest: import('@kraki/protocol').SessionDigest) {
    const store = getStore();
    const device = store.devices.get(deviceId);
    store.upsertSession({
      id: digest.id,
      deviceId,
      deviceName: device?.name ?? deviceId,
      agent: digest.agent,
      model: digest.model,
      reasoningEffort: digest.reasoningEffort,
      createdAt: digest.createdAt,
      title: digest.title,
      autoTitle: digest.autoTitle,
      state: digest.state as SessionState,
      messageCount: digest.messageCount,
      lastSeq: digest.lastSeq,
      readSeq: digest.readSeq,
    });
    const remaining = (store.archivedSessions.get(deviceId) ?? []).filter((s) => s.id !== digest.id);
    store.setArchivedSessions(deviceId, remaining);
    this.archiveSession(digest.id, false);
  }

  requestLocalSessions(targetDeviceId: string, filter?: { search?: string; liveOnly?: boolean; includeLinked?: boolean }) {
    return commands.requestLocalSessions(targetDeviceId, (msg) => this.sendEncrypted(msg), filter);
  }

  importSession(localSessionId: string, targetDeviceId: string, meta?: { cwd?: string; summary?: string; source?: string; model?: string; branch?: string; startTime?: string }) {
    return commands.importSession(localSessionId, targetDeviceId, (msg) => this.sendEncrypted(msg), this.cmdState, meta);
  }

  markRead(sessionId: string, seq?: number, automatic = false): void {
    if (automatic && isAutoReadSuppressed(sessionId)) return;
    if (!automatic) allowAutoRead(sessionId);
    const store = getStore();
    const session = store.sessions.get(sessionId);
    const resolvedSeq = seq ?? session?.lastSeq ?? 0;
    if (session && resolvedSeq > 0) {
      const authoritativeHead = Math.max(session.lastSeq ?? 0, resolvedSeq);
      store.upsertSession({
        ...session,
        lastSeq: authoritativeHead,
        readSeq: Math.min(resolvedSeq, authoritativeHead),
      });
      markSessionRead(sessionId);
      this.sendEncrypted({
        type: 'mark_read',
        sessionId,
        payload: { seq: resolvedSeq },
      });
    }
  }

  markUnread(sessionId: string): void {
    suppressAutoRead(sessionId);
    const store = getStore();
    const session = store.sessions.get(sessionId);
    const lastSeq = session?.lastSeq ?? 0;
    if (session && lastSeq > 0) {
      store.upsertSession({
        ...session,
        readSeq: Math.min(session.readSeq ?? lastSeq, Math.max(0, lastSeq - 1)),
      });
    }
    this.sendEncrypted({
      type: 'mark_unread',
      sessionId,
      payload: {},
    });
  }

  /** Head-terminated control ops — over pulse (was raw transport.send). */
  updatePreferences(prefs: Record<string, unknown>): void {
    this.sendToHead({ type: 'update_preferences', preferences: prefs });
  }
  removeDevice(deviceId: string): void {
    this.sendToHead({ type: 'remove_device', deviceId });
  }
  /** Give a device of this account a custom name; '' goes back to its own. */
  renameDevice(deviceId: string, name: string): void {
    this.sendToHead({ type: 'rename_device', deviceId, name });
  }
  registerPushToken(payload: { provider: string; token: string }): void {
    this.sendToHead({ type: 'register_push_token', payload });
  }
  unregisterPushToken(payload: { provider: string }): void {
    this.sendToHead({ type: 'unregister_push_token', payload });
  }

  /**
   * Handle session_list from tentacle: update metadata, trigger initial loads via provider.
   */
  // TODO: Batch store updates — currently each session triggers individual Zustand set() calls,
  // causing N re-renders on reconnect. Build maps first, then set() once.
  private handleSessionList(msg: SessionListMessage): void {
    diag.work('web/session_list', undefined, () => this.applySessionList(msg));
  }

  private applySessionList(msg: SessionListMessage): void {
    const store = getStore();
    const tentacleSessions = msg.payload?.sessions ?? [];
    const tentacleDeviceId = msg.deviceId;
    const tentacleIds = new Set(tentacleSessions.map(s => s.id));

    logger.info('session_list received', { tentacleDeviceId, sessionCount: tentacleSessions.length });

    if (typeof msg.payload?.archivedCount === 'number') {
      store.setArchiveInfo(tentacleDeviceId, {
        count: msg.payload.archivedCount,
        days: msg.payload.autoArchiveDays ?? 14,
      });
    }

    // Remove local sessions from this tentacle that are no longer in the list
    for (const [sid, session] of store.sessions) {
      if (session.deviceId === tentacleDeviceId && !tentacleIds.has(sid)) {
        diag.replies.missedEnd(sid);
        store.removeSession(sid);
      }
    }

    diag.replies.expire();
    for (const ts of tentacleSessions) {
      if (ts.state === 'idle') diag.replies.missedEnd(ts.id);
    }

    // Update session metadata and trigger initial loads
    const pinnedFromTentacle = new Set<string>();
    for (const ts of tentacleSessions) {
      const currentStore = getStore();
      const previousSession = currentStore.sessions.get(ts.id);
      const device = currentStore.devices.get(tentacleDeviceId);
      if (previousSession && ts.readSeq < (previousSession.readSeq ?? 0)) {
        suppressAutoRead(ts.id);
      } else if (previousSession && ts.readSeq > (previousSession.readSeq ?? 0)) {
        allowAutoRead(ts.id);
      }
      store.upsertSession({
        id: ts.id,
        deviceId: tentacleDeviceId,
        deviceName: device?.name ?? tentacleDeviceId,
        agent: ts.agent,
        model: ts.model,
        reasoningEffort: ts.reasoningEffort,
        createdAt: ts.createdAt,
        title: ts.title,
        autoTitle: ts.autoTitle,
        state: ts.state as SessionState,
        messageCount: ts.messageCount,
        lastSeq: ts.lastSeq,
        readSeq: ts.readSeq,
      });

      if (ts.mode) {
        store.setSessionMode(ts.id, normalizeSessionMode(ts.mode));
      }

      // Apply sidebar preview from tentacle (Tier 0: instant sidebar).
      // The enriched digest is the single authority: it carries an attention
      // preview while one is open, otherwise it carries the spine-derived
      // preview (agent/user/error/answer) - or nothing for an empty session.
      // Mirror that exactly: set when present, clear when absent, so a resolved
      // question/permission can never leave a stale `type:'question'` preview
      // pinning the sidebar on a phantom "waiting" badge (persisted to
      // localStorage, so it survived reloads too).
      const tsRecord = ts as unknown as Record<string, unknown>;
      const preview = tsRecord.preview as { text: string; type: string; timestamp: string } | undefined;
      if (preview?.text) {
        store.setSessionPreview(ts.id, { text: preview.text, type: preview.type, timestamp: preview.timestamp });
      } else {
        store.clearSessionPreview(ts.id);
      }

      if (tsRecord.usage && typeof tsRecord.usage === 'object') {
        store.setSessionUsage(ts.id, tsRecord.usage as import('@kraki/protocol').SessionUsage);
      }

      // Sync pin state from tentacle
      if (ts.pinned) {
        pinnedFromTentacle.add(ts.id);
      }

      // Tentacle's two cursors are the durable unread authority. Local history
      // loading must never guess and overwrite this state.

      // Store tentacle info for later message loading
      messageProvider.setTentacleInfo(ts.id, ts.lastSeq, tentacleDeviceId);

      const runtimeStatus = tsRecord.runtimeStatus as { status?: string; reason?: 'manual' | 'threshold' | 'overflow' } | undefined;
      if (runtimeStatus?.status === 'compacting') {
        store.setRuntimeStatus(ts.id, { status: 'compacting', reason: runtimeStatus.reason });
      } else if (ts.state === 'compacting') {
        // Backward compatibility: older tentacles encoded maintenance directly
        // in session.state and did not send runtimeStatus in the digest.
        store.setRuntimeStatus(ts.id, { status: 'compacting' });
      } else {
        store.setRuntimeStatus(ts.id, null);
      }

      // Session metadata is authoritative for conversational liveness. Runtime
      // maintenance is orthogonal and must not make an idle composer busy.
      if (ts.state === 'active') {
        messageProvider.requestCard(ts.id, true);
      }
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

    this.subscription.onSessionList(tentacleDeviceId);

    // The mounted detail session is foreground authority and must not depend on
    // the global warm-up budget. On reconnect, Safari may keep the route
    // mounted while the SessionPage `sessionId` never changes, so its
    // ensureLoaded effect does not run again. Reconcile directly from this
    // post-auth session_list even before the subscription snapshot ACK arrives;
    // a later snapshot reconcile coalesces through MessageProvider's in-flight
    // tracking.
    const activeSessionId = getStore().activeSessionId;
    const activeDigest = activeSessionId
      ? tentacleSessions.find((session) => session.id === activeSessionId)
      : undefined;
    if (activeDigest && activeDigest.lastSeq > 0) {
      messageProvider.reconcileTail(activeDigest.id, activeDigest.lastSeq);
    }

    // Tier 1: Budget warm-up — pre-fetch messages for likely-needed sessions
    this.runWarmup(tentacleSessions, pinnedFromTentacle);
    // Performance data: the list is fresh; is the open conversation current?
    const viewedId = getStore().activeSessionId;
    const viewed = viewedId ? getStore().sessions.get(viewedId) : undefined;
    diag.stability.sessionListApplied(viewedId && viewed?.lastSeq !== undefined
      ? { sessionId: viewedId, lastSeq: viewed.lastSeq, localSeq: localHighestSeq(viewedId) }
      : null);
  }

  // ── Budget warm-up constants ────────────────────────────
  private static readonly WARMUP_BUDGET = 500;
  private static readonly WARMUP_RECENCY_MS = 24 * 60 * 60 * 1000; // 24 hours
  private static readonly WARMUP_PER_SESSION = 50;

  /**
   * Pre-fetch messages for active, pinned, and recent sessions.
   * Runs async — does not block sidebar rendering.
   *
   * Pass 1: active + pinned + <24h → fetch last 50 (always, outside budget)
   * Pass 2: if budget remains, fill next-most-recent with 50 each
   *
   * When no sessions have preview timestamps (tentacle hasn't sent them),
   * recency can't be determined — fall back to loading all sessions so
   * session state, pending permissions, and unread counts stay correct.
   */
  private runWarmup(
    sessions: import('@kraki/protocol').SessionDigest[],
    pinnedIds: Set<string>,
  ): void {
    const now = Date.now();
    const { WARMUP_BUDGET, WARMUP_RECENCY_MS, WARMUP_PER_SESSION } = KrakiWSClient;

    // If no session has a preview, we can't determine recency — load all.
    const hasPreviewTimestamps = sessions.some(ts => {
      const p = (ts as unknown as Record<string, unknown>).preview as { timestamp?: string } | undefined;
      return !!p?.timestamp;
    });

    if (!hasPreviewTimestamps) {
      for (const ts of sessions) {
        if (ts.lastSeq <= 0) continue;
        const fromSeq = Math.max(1, ts.lastSeq - WARMUP_PER_SESSION + 1);
        messageProvider.fetchRange(ts.id, fromSeq, ts.lastSeq, { initial: true });
      }
      logger.info('warm-up: no preview timestamps, loading all', { sessions: sessions.filter(s => s.lastSeq > 0).length });
      return;
    }

    // Classify sessions
    type WarmupEntry = { id: string; lastSeq: number; previewTs: number };
    const eager: WarmupEntry[] = [];
    const rest: WarmupEntry[] = [];

    for (const ts of sessions) {
      if (ts.lastSeq <= 0) continue;
      const tsRecord = ts as unknown as Record<string, unknown>;
      const preview = tsRecord.preview as { timestamp?: string } | undefined;
      const previewTs = preview?.timestamp ? new Date(preview.timestamp).getTime() : 0;

      const entry: WarmupEntry = { id: ts.id, lastSeq: ts.lastSeq, previewTs };
      const isEager = ts.state === 'active' || ts.state === 'compacting' || pinnedIds.has(ts.id) || (previewTs > 0 && now - previewTs < WARMUP_RECENCY_MS);

      if (isEager) {
        eager.push(entry);
      } else {
        rest.push(entry);
      }
    }

    // Sort rest by recency (most recent first) for budget fill
    rest.sort((a, b) => b.previewTs - a.previewTs);

    // Pass 1: eager sessions (always fetch)
    let used = 0;
    for (const s of eager) {
      const fromSeq = Math.max(1, s.lastSeq - WARMUP_PER_SESSION + 1);
      messageProvider.fetchRange(s.id, fromSeq, s.lastSeq, { initial: true });
      used += Math.min(s.lastSeq, WARMUP_PER_SESSION);
    }

    // Pass 2: fill remaining budget with next-most-recent
    let budgetFilled = 0;
    for (const s of rest) {
      const cost = Math.min(s.lastSeq, WARMUP_PER_SESSION);
      if (used + cost > WARMUP_BUDGET) break;
      const fromSeq = Math.max(1, s.lastSeq - WARMUP_PER_SESSION + 1);
      messageProvider.fetchRange(s.id, fromSeq, s.lastSeq, { initial: true });
      used += cost;
      budgetFilled++;
    }

    logger.info('warm-up scheduled', { eager: eager.length, budgetFill: budgetFilled, skipped: rest.length - budgetFilled, totalMsgs: used, budget: WARMUP_BUDGET });
  }

  private invalidatePeerCrypto(peer: string): void {
    this.peerEpochs.set(peer, (this.peerEpochs.get(peer) ?? 0) + 1);
    this.subscription.onTentacleAuthorityReset(peer);
    this.inboundCrypto.clear((domain) => domain.startsWith(`head:${JSON.stringify(peer)}:`)
      || domain.startsWith(`link:${JSON.stringify(peer)}:`));
    this.outboundCrypto.clear((domain) => domain === JSON.stringify([peer]));
  }

  /** Clear all in-progress tracking (used on disconnect/close). */
  private clearReplayTracking(): void {
    this.foregroundActivity.stop();
    messageProvider.clear();
  }

  /**
   * Handle a range-fetch batch — delegate to message provider.
   */
  private handleRangeBatch(msg: import('@kraki/protocol').SessionMessagesRangeBatchMessage): void {
    const { sessionId, messages, firstSeq, lastSeq, truncated } = msg.payload;
    if (!sessionId) return;
    messageProvider.handleRangeBatch(sessionId, messages, firstSeq, lastSeq, truncated);
  }

  // --- Internal ---

  private async authenticate(): Promise<void> {
    const hasCredentials = this.transport.pairingToken || this.transport.storedDeviceId || this.transport.githubCode
      || desktopCredentials();

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
      {
        codeVerifier: this.transport.codeVerifier,
        redirectUri: this.transport.redirectUri,
      },
    );
    if (usedToken) {
      this.transport.pairingToken = undefined;
    }
    if (this.transport.githubCode) {
      this.transport.githubCode = undefined;
      this.transport.codeVerifier = undefined;
      this.transport.redirectUri = undefined;
    }
  }

  /** Legacy non-Pulse envelopes have only the live domain. Keep their pre-auth
   * queue here so disconnect owns both queued and already-decrypting work. */
  private receiveEncrypted(msg: Parameters<EncryptionHandler['handleEncrypted']>[0]): void {
    if (!getStore().deviceId || !this.encryption.keyStore.isReady()) {
      this.encryptedQueue.push(msg);
      return;
    }
    const sender = typeof msg.src === 'string' ? msg.src : typeof msg.from === 'string' ? msg.from : undefined;
    const valid = this.cryptoGuard(sender, 'head');
    const routeEpoch = sender ? this.routeEpochs.get(sender) : this.routeChanges;
    const complete = this.inboundCrypto.admit<InnerMessage>(`head:${JSON.stringify(sender ?? null)}:0:${routeEpoch ?? 0}`, (inner) => {
      if (!inner || !valid(inner.deviceId)) return;
      if (STALE_ROUTE_DROPPED.has(inner.type)
        && (routeEpoch !== (sender ? this.routeEpochs.get(sender) : this.routeChanges)
          || this.localLink?.isLinked(sender ?? inner.deviceId))) {
        if (this.localLink) this.localLink.stats.staleHeadFrames++;
        return;
      }
      this.dispatchInner(inner);
    });
    try {
      void this.encryption.handleEncrypted(msg, { handleDataMessage: complete, getHandlers: () => [] })
        .then(() => complete(null), () => complete(null));
    } catch { complete(null); }
  }

  private drainEncryptedQueue(): void {
    if (!this.encryption.keyStore.isReady()) return;
    for (const msg of this.encryptedQueue.splice(0)) this.receiveEncrypted(msg);
  }

  private handleMessage(msg: Message) {
    // Handle ping/pong keepalive — not in typed Message union
    const rawType = (msg as unknown as Record<string, unknown>).type;
    if (rawType === 'pong') return;
    if (rawType === 'ping') {
      // Reply with pong so the relay's stale-connection detector (30s no-pong
      // → terminate) doesn't kill us. The relay's protocol-level ws.ping() may
      // be swallowed by nginx; this JSON pong is the reliable fallback.
      this.transport.send({ type: 'pong' });
      return;
    }

    switch (msg.type) {
      // --- Encrypted envelopes ---
      case 'unicast':
      case 'multicast':
      case 'broadcast': {
        // Pulse-framed? Feed the frame to our endpoint; a `deliver` calls
        // handlePulseDelivered with the blob to decrypt.
        const env = msg as unknown as Record<string, unknown>;
        if (typeof env.pulse === 'string') {
          this.pulse.onFrame(env.pulse as string);
          return;
        }
        this.receiveEncrypted(msg as unknown as Parameters<EncryptionHandler['handleEncrypted']>[0]);
        return;
      }

      // --- Control messages ---
      case 'notification_preview': {
        const deviceId = getStore().deviceId;
        if (desktop && deviceId) {
          void this.encryption.keyStore.decryptFromBlob({ blob: msg.payload.blob, keys: { [deviceId]: msg.payload.key } }, deviceId)
            .then(presentDesktopPreview).catch(() => {});
        }
        break;
      }
      case 'auth_ok':
        this.transport.setAuthenticated(true);
        processAuthOk(msg, this.transport.url, {
          setStoredDeviceId: (id) => { this.transport.storedDeviceId = id; },
          drainEncryptedQueue: () => this.drainEncryptedQueue(),
        });
        // Performance data: signed with this device's own key (native
        // KrakiDiag.configure), then the opening/outage clocks move on.
        if (getStore().deviceId) {
          diag.configure(this.transport.url, getStore().deviceId!, (m) => this.encryption.keyStore.signChallenge(m));
        }
        diag.record('ws.state', undefined, { state: 'connected' });
        diag.stability.authenticated();
        // Bring up the pulse endpoint + start the tick loop.
        this.pulse.onConnected();
        this.startPulseTick();
        this.foregroundActivity.start();
        if (desktop && getStore().deviceId) this.sendToHead({ type: 'register_push_token', payload: { provider: 'local', token: getStore().deviceId } });
        this.attachmentPulls.resume();
        this.localLink?.start();
        this.localLink?.poke();
        this.subscription.resume();
        {
          const ok = msg as unknown as { voice?: import('@kraki/protocol').VoiceCapability; voiceVocabulary?: import('@kraki/protocol').VoiceWord[] };
          voice.onAuthOk(ok.voice, ok.voiceVocabulary);
        }
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
        if ((msg as { code?: string }).code === 'account_deleted') { this.accountWasDeleted(); break; }
        processAuthError(msg as Parameters<typeof processAuthError>[0], this.transport.storedDeviceId, {
          clearStoredDeviceId: () => { diag.phase('logout'); this.transport.storedDeviceId = undefined; },
          setStoredDeviceId: (id: string) => { this.transport.storedDeviceId = id; },
          disconnect: () => this.disconnect(),
          connect: () => this.connect(),
          redirectToRelay: (url: string) => this.transport.redirectToRelay(url),
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

      case 'voice_lease_grant' as Message['type']:
        voice.onLeaseGrant((msg as unknown as { lease: import('@kraki/protocol').VoiceLease }).lease);
        break;
      case 'voice_lease_denied' as Message['type']: {
        const d = msg as unknown as { reason: string; detail?: string };
        voice.onLeaseDenied(d.reason, d.detail);
        break;
      }
      case 'voice_vocabulary_updated' as Message['type']: {
        const v = msg as unknown as { words?: import('@kraki/protocol').VoiceWord[]; requestId?: string };
        if (Array.isArray(v.words)) voice.onWordsUpdated(v.words, v.requestId);
        break;
      }

      case 'account_deleted' as Message['type']:
        this.accountWasDeleted();
        break;

      case 'server_error': {
        const serverErr = msg as ServerErrorMessage;
        // A server error while a deletion is pending is its answer.
        const del = useAccountDeletion.getState();
        if (del.state.kind === 'deleting') del.set({ kind: 'failed', message: serverErr.message || t('app:errors.deleteAccount') });
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
          // Head emits device_joined for every authenticated connection epoch,
          // including same-device socket replacement where no device_left is
          // broadcast. Tentacle rebuilds currentSessionByArm during that auth.
          // A linked Tentacle reconnecting to the Head keeps the link's
          // subscription (it only rebuilds Head-routed authority).
          if (joined.device.role === 'tentacle' && !this.localLink?.isLinked(joined.device.id)) {
            this.invalidatePeerCrypto(joined.device.id);
            if (this.deviceFeatures.get(joined.device.id)?.has(PAYLOAD_FRAGMENT_FEATURE)) {
              this.declareClientFeatures(joined.device.id);
            }
          }
          getStore().upsertDevice(joined.device);
        }
        break;
      }

      case 'device_left': {
        const left = msg as DeviceLeftMessage;
        // Still reachable over the local link: nothing changes for this App.
        if (left.deviceId && this.localLink?.isLinked(left.deviceId)) break;
        if (left.deviceId) {
          this.invalidatePeerCrypto(left.deviceId);
          getStore().clearDeviceAgents(left.deviceId);
          getStore().setDeviceOnline(left.deviceId, false);
        }
        break;
      }

      case 'device_renamed': {
        const renamed = msg as DeviceRenamedMessage;
        if (renamed.deviceId && typeof renamed.name === 'string') {
          getStore().renameDevice(renamed.deviceId, renamed.name, renamed.defaultName);
        }
        break;
      }

      case 'device_removed': {
        const removed = msg as { deviceId: string };
        if (removed.deviceId) {
          this.invalidatePeerCrypto(removed.deviceId);
          getStore().clearDeviceAgents(removed.deviceId);
          getStore().removeDevice(removed.deviceId);
        }
        break;
      }

      case 'preferences_updated': {
        const prefsMsg = msg as { preferences?: Record<string, unknown> };
        if (prefsMsg.preferences) {
          const store = getStore();
          const currentUser = store.user;
          if (currentUser) {
            store.setUser({ ...currentUser, preferences: { ...currentUser.preferences, ...prefsMsg.preferences } });
          }
          applyPreferences(prefsMsg.preferences);
        }
        break;
      }

      // local_sessions_list can arrive as plaintext (mock/e2e) or decrypted (production)
      case 'local_sessions_list' as Message['type']: {
        const payload = (msg as unknown as { payload: { sessions: unknown[]; requestId?: string } }).payload;
        if (payload?.sessions) {
          getStore().setLocalSessions(payload.sessions as import('@kraki/protocol').LocalSession[]);
          getStore().setLocalSessionsLoading(false);
        }
        break;
      }

      default:
        // Data messages (session_created, agent_message, etc.) arrive encrypted
        // in production but as plaintext from mock relay in E2E tests.
        // Route them to the message router so both paths work.
        if ('sessionId' in msg || 'payload' in msg) {
          this.dispatchInner(msg as unknown as InnerMessage);
        }
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
