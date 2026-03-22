import type { Message } from '@kraki/protocol';
import { getStore } from './store-adapter';

export type MessageHandler = (msg: Message) => void;

const DEFAULT_RELAY = import.meta.env.VITE_WS_URL ?? 'wss://kraki.corelli.cloud';
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;
const PING_INTERVAL = 25000;
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
    if (import.meta.env.DEV) console.log('[Kraki] loadStoredDevice:', result);
    return result;
  } catch { return null; }
}

export function saveStoredDevice(device: StoredDevice): void {
  if (import.meta.env.DEV) console.log('[Kraki] saveStoredDevice:', device);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
}

export interface TransportCallbacks {
  onOpen: () => Promise<void>;
  onParsedMessage: (msg: Message) => void;
  onClose?: () => void;
}

export const OAUTH_STATE_KEY = 'kraki_oauth_state';

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

/** Generate a random OAuth state param and store it persistently for CSRF protection */
export function startOAuthFlow(clientId: string): void {
  const state = crypto.randomUUID();
  storeOAuthState(state);
  const redirectUri = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state,
  });
  window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export class KrakiTransport {
  private ws: WebSocket | null = null;
  private _url: string;
  pairingToken?: string;
  githubCode?: string;
  storedDeviceId?: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  intentionalClose = false;
  private callbacks: TransportCallbacks;

  get url(): string { return this._url; }

  constructor(callbacks: TransportCallbacks, url?: string) {
    const params = getUrlParams();
    const stored = loadStoredDevice();

    this._url = url ?? params.relay ?? (import.meta.env.VITE_WS_URL || stored?.relay) ?? DEFAULT_RELAY;
    this.pairingToken = params.token;
    this.storedDeviceId = stored?.deviceId;
    this.callbacks = callbacks;

    // Validate and extract GitHub OAuth code from callback
    if (params.githubCode) {
      if (consumeOAuthState(params.oauthState)) {
        this.githubCode = params.githubCode;
      } else {
        getStore().setLastError('GitHub sign-in could not be verified. Please try again.');
        if (import.meta.env.DEV) {
          console.warn('[Kraki] OAuth state mismatch — ignoring code');
        }
      }
    }

    // Clean URL params after reading (don't leak pairing token or OAuth code in address bar)
    if (params.token || params.githubCode) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  connect() {
    getStore().setStatus('connecting');
    this.intentionalClose = false;

    try {
      this.ws = new WebSocket(this._url);
    } catch {
      getStore().setStatus('error');
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = async () => {
      this.reconnectDelay = RECONNECT_BASE;
      await this.callbacks.onOpen();
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as Message;
        this.callbacks.onParsedMessage(msg);
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn('[Kraki] Malformed WS message:', event.data, err);
        }
      }
    };

    this.ws.onclose = () => {
      this.cleanup();
      this.callbacks.onClose?.();
      if (!this.intentionalClose) {
        getStore().setStatus('disconnected');
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      getStore().setStatus('error');
    };
  }

  disconnect() {
    this.intentionalClose = true;
    this.cleanup();
    this.ws?.close();
    this.ws = null;
    getStore().setStatus('disconnected');
  }

  send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
  }

  private cleanup() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
