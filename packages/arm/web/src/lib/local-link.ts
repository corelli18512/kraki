/**
 * Local link (desktop app only): a direct loopback connection from Kraki for
 * Windows/Linux to the Tentacle running on the same machine, instead of a
 * round trip through the Head. Same protocol as Kraki for Mac
 * (packages/tentacle/src/local-link.ts, LocalLinkClient.swift):
 *
 *   - Discovery: `<KRAKI_HOME>/local-link.json`, read by the desktop shell.
 *   - Handshake: mutual proof with the device keys the Head registered,
 *     domain-separated from Head challenge auth. Driven by a strict state
 *     machine: we sign only after the Tentacle's proof verifies, and accept
 *     `ready` only after sending ours; anything out of order fails closed.
 *   - Payloads: the same E2E `{blob, keys}` ciphertext, over a per-connection
 *     Pulse stream (ArmPulse). The link is the sender (`src`).
 *
 * The Head stays connected for identity, other computers, push and so on.
 */
import { ArmPulse } from './arm-pulse';
import { createLogger } from './logger';

const logger = createLogger('local-link');

export const LOCAL_LINK_VERSION = 1;
const POLL_MS = 2000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const TICK_MS = 5000;

export function tentacleProof(appNonce: string, appId: string, tentacleId: string): string {
  return `kraki-local-link/v${LOCAL_LINK_VERSION}/tentacle\n${appNonce}\n${appId}\n${tentacleId}`;
}
export function appProof(tentacleNonce: string, tentacleId: string, appId: string): string {
  return `kraki-local-link/v${LOCAL_LINK_VERSION}/app\n${tentacleNonce}\n${tentacleId}\n${appId}`;
}

/** Failed attempts back off 2 s, 4 s, … up to 60 s. */
export function backoffMs(failures: number): number {
  return Math.min(60_000, POLL_MS * 2 ** Math.max(0, failures - 1));
}

export type HandshakeAction =
  | { t: 'send'; msg: Record<string, unknown> }
  | { t: 'linkUp' }
  | { t: 'pulse'; frame: string }
  | { t: 'fail'; reason: string }
  | { t: 'ignore' };

type Phase = 'awaitingChallenge' | 'signing' | 'authSent' | 'ready' | 'failed';

/** Client side of the handshake as a pure state machine (async crypto). */
export class LocalLinkHandshake {
  phase: Phase = 'awaitingChallenge';

  constructor(
    readonly appId: string,
    readonly tentacleId: string,
    readonly appNonce: string,
    private readonly verifyTentacle: (message: string, signature: string) => Promise<boolean>,
    private readonly signApp: (message: string) => Promise<string | null>,
  ) {}

  async receive(msg: Record<string, unknown>): Promise<HandshakeAction> {
    if (this.phase === 'failed') return { t: 'ignore' };
    const type = msg.type;
    if (type === 'error') return this.fail(`rejected: ${String(msg.code ?? '?')}`);
    if (this.phase === 'awaitingChallenge' && type === 'challenge') {
      const nonce = msg.nonce;
      if (msg.v !== LOCAL_LINK_VERSION || msg.tentacleId !== this.tentacleId
        || typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 256
        || typeof msg.signature !== 'string') return this.fail('bad challenge');
      // No other frame is accepted while the proofs are being checked.
      this.phase = 'signing';
      const ok = await this.verifyTentacle(tentacleProof(this.appNonce, this.appId, this.tentacleId), msg.signature)
        .catch(() => false);
      if (this.phase !== 'signing') return { t: 'ignore' };
      if (!ok) return this.fail('tentacle proof did not verify');
      const signature = await this.signApp(appProof(nonce, this.tentacleId, this.appId)).catch(() => null);
      if (this.phase !== 'signing') return { t: 'ignore' };
      if (!signature) return this.fail('cannot sign app proof');
      this.phase = 'authSent';
      return { t: 'send', msg: { type: 'auth', signature } };
    }
    if (this.phase === 'authSent' && type === 'ready') {
      if (msg.v !== LOCAL_LINK_VERSION) return this.fail('bad ready');
      this.phase = 'ready';
      return { t: 'linkUp' };
    }
    if (this.phase === 'ready' && type === 'pulse') {
      return typeof msg.pulse === 'string' ? { t: 'pulse', frame: msg.pulse } : { t: 'ignore' };
    }
    return this.fail(`unexpected ${String(type ?? 'frame')} during ${this.phase}`);
  }

  private fail(reason: string): HandshakeAction {
    this.phase = 'failed';
    return { t: 'fail', reason };
  }
}

export interface Discovery { v: number; port: number; tentacleId?: string }

export interface LocalLinkHost {
  /** Raw discovery file contents (desktop shell), or null. */
  readDiscovery(): Promise<string | null>;
  /** This App's device id once signed in to the Head. */
  appId(): string | null;
  /** The registered signing key (SPKI base64) of a Tentacle of this account. */
  tentacleKey(tentacleId: string): string | undefined;
  /** Sign a domain-separated proof with this App's registered key. */
  sign(message: string): Promise<string>;
  onLinkChange(tentacleId: string, linked: boolean, unacked: Array<{ payload: string; target: string }>): void;
  /** A Pulse-delivered payload from the linked Tentacle (`src` stamped). */
  onDelivered(payloadJson: string): void;
  createSocket?(url: string): WebSocket;
}

export async function verifyRsaPkcs1(spkiBase64: string, message: string, signatureBase64: string): Promise<boolean> {
  const der = Uint8Array.from(atob(spkiBase64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const sig = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(message));
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export class LocalLinkClient {
  private started = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private ws: WebSocket | null = null;
  private handshake: LocalLinkHandshake | null = null;
  private pulse: ArmPulse | null = null;
  private generation = 0;
  private failures = 0;
  private nextAttemptAt = 0;
  private lastDiscovery = '';
  private linkedThisAttempt = false;
  private connecting = false;
  /** Idempotent commands sent over the link and not yet acknowledged; on link
   *  loss they are handed back so the Head route can deliver them. */
  private replayable: Array<{ seq: bigint; payload: string; target: string }> = [];
  linkedTentacleId: string | null = null;
  lastError: string | null = null;
  readonly stats = { linkUps: 0, payloadsIn: 0, payloadsOut: 0, replayedViaHead: 0, staleHeadFrames: 0 };

  constructor(private readonly host: LocalLinkHost) {}

  isLinked(tentacleId: string | undefined | null): boolean {
    return !!tentacleId && this.linkedTentacleId === tentacleId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.lastDiscovery = '';
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.teardown('stopped');
  }

  /** Re-check discovery now (e.g. right after the Head sign-in). */
  poke(): void { void this.poll(); }

  private async poll(): Promise<void> {
    if (!this.started || this.ws || this.connecting) return;
    const appId = this.host.appId();
    if (!appId) return;
    this.connecting = true;
    try {
      const raw = await this.host.readDiscovery().catch(() => null);
      if (!raw || !this.started || this.ws) return;
      let d: Discovery;
      try { d = JSON.parse(raw) as Discovery; } catch { return; }
      if (d.v !== LOCAL_LINK_VERSION || !Number.isInteger(d.port) || d.port <= 0 || d.port > 65535 || !d.tentacleId) return;
      const fingerprint = `${d.port}|${d.tentacleId}`;
      if (fingerprint !== this.lastDiscovery) {
        this.lastDiscovery = fingerprint;
        this.failures = 0;
        this.nextAttemptAt = 0;
      }
      if (Date.now() < this.nextAttemptAt) return;
      // Only a Tentacle of this account: its registered key authenticates it.
      const key = this.host.tentacleKey(d.tentacleId);
      if (!key) return;
      this.connect(d.port, d.tentacleId, appId, key);
    } finally {
      this.connecting = false;
    }
  }

  private connect(port: number, tentacleId: string, appId: string, key: string): void {
    const epoch = ++this.generation;
    const nonce = randomNonce();
    this.handshake = new LocalLinkHandshake(
      appId, tentacleId, nonce,
      (message, signature) => verifyRsaPkcs1(key, message, signature),
      (message) => this.host.sign(message),
    );
    this.linkedThisAttempt = false;
    const url = `ws://127.0.0.1:${port}`;
    let ws: WebSocket;
    try {
      ws = this.host.createSocket ? this.host.createSocket(url) : new WebSocket(url);
    } catch {
      this.noteFailure();
      return;
    }
    this.ws = ws;
    // Frames are handled strictly in order even though crypto is async.
    let chain: Promise<void> = Promise.resolve();
    ws.onopen = () => {
      if (epoch !== this.generation) return;
      ws.send(JSON.stringify({ type: 'hello', v: LOCAL_LINK_VERSION, appId, nonce }));
    };
    ws.onmessage = (event) => {
      chain = chain.then(() => this.handle(epoch, String(event.data)));
    };
    ws.onclose = () => { if (epoch === this.generation) this.fail('socket closed'); };
    ws.onerror = () => { /* close follows */ };
    this.handshakeTimer = setTimeout(() => {
      if (epoch === this.generation && !this.linkedTentacleId) this.fail('handshake timeout');
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private async handle(epoch: number, text: string): Promise<void> {
    if (epoch !== this.generation || !this.handshake) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text) as Record<string, unknown>; } catch { this.fail('malformed frame'); return; }
    const action = await this.handshake.receive(msg);
    if (epoch !== this.generation) return;
    switch (action.t) {
      case 'send': this.ws?.send(JSON.stringify(action.msg)); break;
      case 'linkUp': this.becomeReady(); break;
      case 'pulse': this.pulse?.onFrame(action.frame); break;
      case 'fail': this.fail(action.reason); break;
      case 'ignore': break;
    }
  }

  private becomeReady(): void {
    const hs = this.handshake;
    if (!hs || hs.phase !== 'ready' || this.linkedTentacleId) return;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.linkedThisAttempt = true;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.lastError = null;
    this.stats.linkUps++;
    const ws = this.ws!;
    const tentacleId = hs.tentacleId;
    this.pulse = new ArmPulse({
      now: () => Date.now(),
      sendPulseFrame: (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pulse', pulse: frame })); },
      onDelivered: (payloadJson) => {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(payloadJson) as Record<string, unknown>; } catch { return; }
        if (parsed.from !== undefined) return; // never Head control from a Tentacle
        parsed.src = tentacleId;
        this.stats.payloadsIn++;
        this.host.onDelivered(JSON.stringify(parsed));
      },
      onAcked: (seqUpTo) => { this.replayable = this.replayable.filter((r) => r.seq > seqUpTo); },
    }, `arm-local:${tentacleId}:${Date.now()}`);
    // Route first, then let link data (the session_list barrier) flow.
    this.linkedTentacleId = tentacleId;
    this.host.onLinkChange(tentacleId, true, []);
    this.pulse.onConnected();
    this.tickTimer = setInterval(() => this.pulse?.tick(), TICK_MS);
    logger.info('local link ready', { tentacleId });
  }

  /** Send E2E ciphertext to the linked Tentacle. False when not linked. */
  send(payloadJson: string, target: string, replayable: boolean): boolean {
    if (!this.pulse || this.linkedTentacleId !== target) return false;
    const seq = this.pulse.send(payloadJson, target, false);
    if (replayable) this.replayable.push({ seq, payload: payloadJson, target });
    this.stats.payloadsOut++;
    return true;
  }

  /** Test/diagnostic hook: drop the link as if the socket died. */
  dropForTesting(): void { this.fail('debug drop'); }

  private noteFailure(): void {
    this.failures++;
    this.nextAttemptAt = Date.now() + backoffMs(this.failures);
  }

  private fail(reason: string): void {
    this.lastError = reason;
    logger.info('local link down', { reason });
    this.teardown(reason);
  }

  private teardown(reason: string): void {
    if (this.ws && !this.linkedThisAttempt) this.noteFailure();
    this.generation++;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.handshakeTimer = null;
    this.tickTimer = null;
    const unacked = this.replayable.map(({ payload, target }) => ({ payload, target }));
    this.replayable = [];
    this.pulse?.onDisconnected();
    this.pulse = null;
    this.handshake = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* ignore */ } }
    const linked = this.linkedTentacleId;
    if (linked) {
      this.linkedTentacleId = null;
      this.stats.replayedViaHead += unacked.length;
      logger.info('local link: back on Head', { reason, tentacleId: linked, replay: unacked.length });
      this.host.onLinkChange(linked, false, unacked);
    }
  }
}

/** Commands the Tentacle handles idempotently; safe to deliver again through
 *  the Head when the link died before confirming them. Same set as Mac. */
export const REPLAYABLE_ACROSS_ROUTES = new Set([
  'send_input', 'approve', 'deny', 'always_allow',
  'set_session_mode', 'set_session_model', 'rename_session', 'pin_session',
  'mark_read', 'archive_session', 'delete_session', 'kill_session',
]);

/** Live, connection-scoped messages that must not be applied when they come
 *  through the Head from a Tentacle this App is linked to (they were sent
 *  before the switch and would duplicate or revert the link's live state). */
export const STALE_ROUTE_DROPPED = new Set(['agent_message_delta', 'card_action', 'session_subscription_set']);
