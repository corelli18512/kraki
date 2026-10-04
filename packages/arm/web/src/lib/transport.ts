import { desktopCredentials } from './desktop';
import type { Message } from '@kraki/protocol';
import { createLogger } from './logger';
import { getStore } from './store-adapter';
import { traceEvent } from './trace';

export type MessageHandler = (msg: Message) => void;

const logger = createLogger('transport');

const DEFAULT_RELAY = import.meta.env.VITE_WS_URL ?? 'wss://relay.kraki.chat';
/** Reconnect schedule (same as the native apps): quick while an outage is
 *  young, then back off. Never gives up — a network outage can last long and
 *  the user should not have to click anything once it is back. */
const RECONNECT_BASE = 500;
const RECONNECT_FAST_CAP = 4_000;
const RECONNECT_FAST_WINDOW = 120_000;
const RECONNECT_SLOW = 15_000;
const RECONNECT_SLOW_WINDOW = 300_000;
const RECONNECT_MAX = 30_000;
/** No frame at all for this long on an authenticated socket → dead link
 *  (half-open). Pings every 10 s get a pong, and payload frames are ≤32 KB
 *  from fragment-capable Tentacles, so a live link is never this quiet. */
const LIVENESS_TIMEOUT = 22_000;
const LIVENESS_CHECK = 2_000;
/** A WebSocket handshake that has not opened by now is abandoned. */
const CONNECT_TIMEOUT = 10_000;
/** Application-level ping interval. 10s keeps the connection warm through
 *  proxies and bounds liveness-detection latency during read-only viewing. */
const PING_INTERVAL = 10_000;
export const STORAGE_KEY = 'kraki_device';

export interface StoredDevice {
  relay: string;
  deviceId: string;
}

export function getUrlParams(): { relay?: string; token?: string; key?: string; githubCode?: string; oauthState?: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    relay: params.get('relay') ?? undefined,
    token: params.get('token') ?? undefined,
    key: params.get('key') ?? undefined,
    githubCode: params.get('code') ?? undefined,
    oauthState: params.get('state') ?? undefined,
  };
}

export function loadStoredDevice(): StoredDevice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const result = raw ? JSON.parse(raw) : null;
    logger.info('loadStoredDevice:', result);
    return result;
  } catch { return null; }
}

export function saveStoredDevice(device: StoredDevice): void {
  logger.info('saveStoredDevice:', device);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
}

export interface TransportCallbacks {
  onOpen: () => Promise<void>;
  onParsedMessage: (msg: Message) => void;
  onClose?: () => void;
}

export const OAUTH_STATE_KEY = 'kraki_oauth_state';
export const OAUTH_VERIFIER_KEY = 'kraki_oauth_verifier';
export const OAUTH_REDIRECT_KEY = 'kraki_oauth_redirect';

/** Path the SPA uses as its GitHub OAuth redirect URI. */
export const OAUTH_CALLBACK_PATH = '/auth/callback';

function safeGetItem(storage: Storage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(storage: Storage | undefined, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore storage failures and fall back to the remaining transport flow.
  }
}

function safeRemoveItem(storage: Storage | undefined, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage failures and continue cleaning up other stores.
  }
}

function getSessionStorage(): Storage | undefined {
  return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;
}

function getLocalStorage(): Storage | undefined {
  return typeof localStorage !== 'undefined' ? localStorage : undefined;
}

export function storeOAuthState(state: string): void {
  safeSetItem(getSessionStorage(), OAUTH_STATE_KEY, state);
  safeSetItem(getLocalStorage(), OAUTH_STATE_KEY, state);
}

export function consumeOAuthState(returnedState: string | undefined): boolean {
  const sessionState = safeGetItem(getSessionStorage(), OAUTH_STATE_KEY);
  const localState = safeGetItem(getLocalStorage(), OAUTH_STATE_KEY);

  safeRemoveItem(getSessionStorage(), OAUTH_STATE_KEY);
  safeRemoveItem(getLocalStorage(), OAUTH_STATE_KEY);

  return !!returnedState && (returnedState === sessionState || returnedState === localState);
}

function storePkceMaterial(verifier: string, redirectUri: string): void {
  for (const storage of [getSessionStorage(), getLocalStorage()]) {
    safeSetItem(storage, OAUTH_VERIFIER_KEY, verifier);
    safeSetItem(storage, OAUTH_REDIRECT_KEY, redirectUri);
  }
}

/**
 * Pop the stored PKCE verifier + redirect URI used to start this
 * OAuth flow. Removes from both session and local storage so a stale
 * code can't be replayed against a freshly-generated verifier.
 */
export function consumePkceMaterial(): { codeVerifier?: string; redirectUri?: string } {
  const verifier = safeGetItem(getSessionStorage(), OAUTH_VERIFIER_KEY)
    ?? safeGetItem(getLocalStorage(), OAUTH_VERIFIER_KEY) ?? undefined;
  const redirectUri = safeGetItem(getSessionStorage(), OAUTH_REDIRECT_KEY)
    ?? safeGetItem(getLocalStorage(), OAUTH_REDIRECT_KEY) ?? undefined;
  for (const storage of [getSessionStorage(), getLocalStorage()]) {
    safeRemoveItem(storage, OAUTH_VERIFIER_KEY);
    safeRemoveItem(storage, OAUTH_REDIRECT_KEY);
  }
  return { codeVerifier: verifier ?? undefined, redirectUri: redirectUri ?? undefined };
}

/** Generate a high-entropy PKCE code verifier (RFC 7636 §4.1). 43–128 chars. */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** SHA-256 the verifier, base64url-encode the digest. PKCE S256 challenge. */
async function deriveCodeChallenge(verifier: string): Promise<string> {
  const buf = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Start the GitHub OAuth flow.
 *
 * Builds a CSRF state + PKCE verifier/challenge, persists both, and
 * navigates to GitHub's authorize endpoint with a fixed dedicated
 * callback path (`/auth/callback`). The same callback path is the
 * one that future Universal Links / App Links setups will claim, so
 * mobile clients can intercept the same URL without changing the
 * OAuth App config.
 */
export async function startOAuthFlow(clientId: string): Promise<void> {
  const state = crypto.randomUUID();
  storeOAuthState(state);

  const verifier = generateCodeVerifier();
  const challenge = await deriveCodeChallenge(verifier);

  // The desktop shell serves the app from its own origin, which GitHub does
  // not know; it uses the Web's registered origin and intercepts the redirect.
  const origin = window.krakiDesktop?.oauthRedirectOrigin ?? window.location.origin;
  const redirectUri = origin + OAUTH_CALLBACK_PATH;
  storePkceMaterial(verifier, redirectUri);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export class KrakiTransport {
  private ws: WebSocket | null = null;
  private _url: string;
  pairingToken?: string;
  githubCode?: string;
  /** PKCE verifier matching the challenge sent at authorize time. */
  codeVerifier?: string;
  /** The exact redirect_uri used at authorize time — required at exchange. */
  redirectUri?: string;
  storedDeviceId?: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  intentionalClose = false;
  private reconnectAttempts = 0;
  private callbacks: TransportCallbacks;
  private authenticated = false;
  /** When the current outage began (first failed/closed attempt). */
  private outageStartedAt: number | null = null;
  private lastRxAt = 0;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeListenersInstalled = false;

  /** Milliseconds since the last frame from the relay (Infinity if none). */
  msSinceLastRx(now = Date.now()): number {
    return this.lastRxAt ? now - this.lastRxAt : Number.POSITIVE_INFINITY;
  }

  get url(): string { return this._url; }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  constructor(callbacks: TransportCallbacks, url?: string) {
    const params = getUrlParams();
    const stored = loadStoredDevice();

    // The desktop app connects to the relay its built-in Kraki was set up with.
    const desktopRelay = typeof window !== 'undefined' ? desktopCredentials()?.relay : undefined;
    this._url = url ?? params.relay ?? desktopRelay ?? stored?.relay ?? import.meta.env.VITE_WS_URL ?? DEFAULT_RELAY;
    this.pairingToken = params.token;
    this.storedDeviceId = stored?.deviceId;
    this.callbacks = callbacks;

    // Validate and extract GitHub OAuth code from callback. The
    // callback may arrive on the dedicated `/auth/callback` path
    // (current builds) or on the homepage `/` (older builds that ran
    // before the path swap — we still accept the code there so
    // in-flight flows complete cleanly).
    //
    // PKCE material is popped unconditionally whenever we see a
    // `code` parameter — even on state-mismatch — so a stale verifier
    // can't sit in storage indefinitely if an attacker (or stale tab)
    // delivers a malformed callback. Treat the callback as the
    // single-use trigger that consumes the matching verifier.
    if (params.githubCode) {
      const pkce = consumePkceMaterial();
      if (consumeOAuthState(params.oauthState)) {
        this.githubCode = params.githubCode;
        this.codeVerifier = pkce.codeVerifier;
        this.redirectUri = pkce.redirectUri;
      } else {
        getStore().setLastError('GitHub sign-in could not be verified. Please try again.');
        logger.warn('OAuth state mismatch — ignoring code');
      }
    }

    // Clean URL params after reading (don't leak pairing token or
    // OAuth code in address bar). When we landed on the dedicated
    // OAuth callback path, also redirect back to root so a refresh
    // doesn't restart the OAuth attempt on a stale code.
    if (params.token || params.githubCode) {
      const cleanPath = window.location.pathname === OAUTH_CALLBACK_PATH
        ? '/'
        : window.location.pathname;
      window.history.replaceState({}, '', cleanPath);
    }
  }

  connect() {
    if (this.storedDeviceId || this.pairingToken || this.githubCode) {
      getStore().setStatus('connecting');
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectAttempts > 0) {
      getStore().setReconnectState(this.reconnectAttempts, null);
    }
    this.intentionalClose = false;
    this.installWakeListeners();

    let ws: WebSocket;
    try {
      ws = new WebSocket(this._url);
      this.ws = ws;
    } catch {
      getStore().setStatus('error');
      this.scheduleReconnect();
      return;
    }

    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        logger.warn('WebSocket handshake timed out');
        this.abandon(ws);
      }
    }, CONNECT_TIMEOUT);

    ws.onopen = async () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      // Backoff resets on successful auth, not on open: a relay that accepts
      // and drops connections must not be hammered every 0.5 s.
      this.lastRxAt = Date.now();
      await this.callbacks.onOpen();
      this.startPing();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastRxAt = Date.now();
      try {
        const msg = JSON.parse(event.data as string) as Message;
        const rawLen = typeof event.data === 'string' ? event.data.length : 0;
        traceEvent({ comp: 'arm', evt: 'WS-RX', type: (msg as { type?: string }).type, hasPulse: typeof (msg as { pulse?: unknown }).pulse === 'string', rawLen });
        this.callbacks.onParsedMessage(msg);
      } catch (err) {
        logger.warn('Malformed WS message:', event.data, err);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // already abandoned
      this.handleClosed();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // A failed handshake is followed by onclose, which reconnects. Keep a
      // previously working session in "disconnected" (reconnecting), not
      // "error" (which reads as a first-connect failure).
      if (this.outageStartedAt === null && this.reconnectAttempts === 0 && !this.authenticated) {
        getStore().setStatus('error');
      }
    };
  }

  private handleClosed() {
    this.cleanup();
    this.callbacks.onClose?.();
    if (!this.intentionalClose) {
      getStore().setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  /** Stop using a socket that is dead but has not closed (half-open, stuck
   *  handshake). The browser may take minutes to fire onclose on its own. */
  private abandon(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch { /* already closing */ }
    this.handleClosed();
  }

  /** Browser signals that the network may be back: retry now instead of
   *  waiting out the backoff. */
  private installWakeListeners() {
    if (this.wakeListenersInstalled || typeof window === 'undefined') return;
    this.wakeListenersInstalled = true;
    const wake = (reason: string) => {
      if (this.intentionalClose || !this.reconnectTimer) return;
      logger.info('Reconnecting now:', reason);
      this.reconnectDelay = RECONNECT_BASE;
      this.connect();
    };
    window.addEventListener('online', () => wake('online'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake('visible');
    });
  }

  disconnect() {
    this.intentionalClose = true;
    this.cleanup();
    this.ws?.close();
    this.ws = null;
    this.reconnectAttempts = 0;
    this.outageStartedAt = null;
    getStore().setReconnectState(0, null);
    getStore().setStatus('disconnected');
  }

  /** Pair with a scanned QR code — set relay + token and reconnect. */
  pairWithToken(relay: string, token: string) {
    this.disconnect();
    this._url = relay;
    this.pairingToken = token;
    this.storedDeviceId = undefined;
    this.intentionalClose = false;
    this.connect();
  }

  redirectToRelay(relay: string) {
    this.disconnect();
    this._url = relay;
    this.intentionalClose = false;
    this.connect();
  }

  send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Send without auth gate — used only for auth handshake messages. */
  sendRaw(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  setAuthenticated(value: boolean) {
    this.authenticated = value;
    if (value) {
      this.reconnectDelay = RECONNECT_BASE;
      this.reconnectAttempts = 0;
      this.outageStartedAt = null;
    }
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL);
    const ws = this.ws;
    this.livenessTimer = setInterval(() => {
      if (!ws || this.ws !== ws || !this.authenticated) return;
      if (this.msSinceLastRx() > LIVENESS_TIMEOUT) {
        logger.warn('No frames from relay — link is dead, reconnecting');
        traceEvent({ comp: 'arm', evt: 'WS-LIVENESS-TIMEOUT', quietMs: this.msSinceLastRx() });
        this.abandon(ws);
      }
    }, LIVENESS_CHECK);
  }

  /** Next reconnect delay for an outage that began `outageMs` ago. */
  static reconnectDelayFor(previous: number, outageMs: number, random = Math.random()): number {
    const base = outageMs < RECONNECT_FAST_WINDOW
      ? Math.min(previous, RECONNECT_FAST_CAP)
      : outageMs < RECONNECT_SLOW_WINDOW ? RECONNECT_SLOW : RECONNECT_MAX;
    return Math.round(base * (0.8 + 0.4 * random));
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const now = Date.now();
    this.outageStartedAt ??= now;
    const delayMs = KrakiTransport.reconnectDelayFor(this.reconnectDelay, now - this.outageStartedAt);
    this.reconnectAttempts += 1;
    getStore().setReconnectState(this.reconnectAttempts, delayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
  }

  private cleanup() {
    this.authenticated = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
