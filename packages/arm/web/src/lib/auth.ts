import { t } from '../i18n';
import { desktopCredentials } from './desktop';
import { isAcceptableRegionRedirect, type AuthOkMessage } from '@kraki/protocol';
import type { AppKeyStore } from './e2e';
import { createLogger, setDebugLogging } from './logger';
import { getStore } from './store-adapter';
import { saveStoredDevice, STORAGE_KEY } from './transport';
import { supportsOAuthLogin } from './oauth';
import { setTheme } from '../hooks/useTheme';

const logger = createLogger('auth');

/** How this browser appears in Devices: "Chrome on Mac", "Safari on iPhone".
 *  Every browser used to be "Web Browser", so several were indistinguishable. */
export function browserDeviceName(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
      : /(Chrome|CriOS)\//.test(ua) ? 'Chrome'
        : /Safari/.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
            : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : `Web ${browser}`;
}

/** Send the initial auth message. Returns true if a pairing token was consumed. */
export async function sendAuth(
  send: (msg: Record<string, unknown>) => void,
  keyStore: AppKeyStore,
  pairingToken: string | undefined,
  storedDeviceId: string | undefined,
  githubCode: string | undefined,
  githubOAuthExtras?: { codeVerifier?: string; redirectUri?: string },
): Promise<boolean> {
  const desktopBridge = window.krakiDesktop;
  const deviceName = desktopBridge?.deviceName ?? browserDeviceName(navigator.userAgent);
  // The desktop app signs in with the token of the Kraki built into it (as
  // Kraki for Mac does with its tentacle's), keeping its device id.
  const desktopToken = desktopCredentials()?.token;

  // Wait for key store if not ready
  if (!keyStore.isReady()) {
    try { await keyStore.init(); } catch { /* continue without E2E */ }
  }

  const publicKey = keyStore.isReady() ? await keyStore.getSigningPublicKey() : undefined;
  const encryptionKey = keyStore.isReady() ? await keyStore.getPublicKey() : undefined;

  const usedToken = !!pairingToken;
  const device = { name: deviceName, role: 'app', kind: desktopBridge ? 'desktop' : 'web', deviceId: storedDeviceId, publicKey, encryptionKey };

  if (desktopToken && !pairingToken && !githubCode) {
    send({
      type: 'auth',
      auth: { method: 'github_token', token: desktopToken },
      device,
    });
  } else if (pairingToken) {
    send({
      type: 'auth',
      auth: { method: 'pairing', token: pairingToken },
      device,
    });
  } else if (githubCode) {
    const oauthAuth: Record<string, unknown> = { method: 'github_oauth', code: githubCode };
    if (githubOAuthExtras?.codeVerifier) oauthAuth.codeVerifier = githubOAuthExtras.codeVerifier;
    if (githubOAuthExtras?.redirectUri) oauthAuth.redirectUri = githubOAuthExtras.redirectUri;
    send({
      type: 'auth',
      auth: oauthAuth,
      device,
    });
  } else if (storedDeviceId) {
    send({
      type: 'auth',
      auth: { method: 'challenge', deviceId: storedDeviceId },
      device,
    });
  } else {
    send({
      type: 'auth',
      auth: { method: 'open' },
      device,
    });
  }

  return usedToken;
}

/**
 * Every Head issues `randomBytes(32).toString('hex')` as its challenge nonce
 * (head local-auth-backend.ts; edges get it from the account service). The
 * same RSA key signs local-link and diagnostics proofs, so any other string
 * is refused rather than signed for whoever sent it.
 */
export function isHeadAuthNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && /^[0-9a-f]{64}$/.test(nonce);
}

/** Sign and respond to an auth challenge from the head. */
export async function handleAuthChallenge(
  nonce: string,
  keyStore: AppKeyStore,
  storedDeviceId: string | undefined,
  send: (msg: Record<string, unknown>) => void,
): Promise<void> {
  if (!isHeadAuthNonce(nonce)) {
    // No reply: the Head's auth deadline closes the socket and we reconnect.
    logger.warn('Refusing to sign an auth challenge that is not a Head nonce');
    return;
  }
  if (!keyStore.isReady()) {
    await keyStore.init();
  }

  try {
    const signature = await keyStore.signChallenge(nonce);
    send({
      type: 'auth_response',
      deviceId: storedDeviceId,
      signature,
    });
  } catch (err) {
    logger.error('Challenge signing failed:', err);
    // Can't sign — need to re-pair
    getStore().setStatus('error');
  }
}

/** Process auth_ok: populate store, save device, drain encrypted queue. */
export function processAuthOk(
  msg: AuthOkMessage,
  transportUrl: string,
  deps: {
    setStoredDeviceId: (id: string) => void;
    drainEncryptedQueue: () => void;
  },
): void {
  const store = getStore();
  store.setStatus('connected');
  store.setReconnectState(0, null);
  store.setAuth(msg.deviceId);
  store.setUser(msg.user ?? null);
  // Apply global preferences from relay
  applyPreferences(msg.user?.preferences);
  if (msg.githubClientId) {
    store.setGithubClientId(msg.githubClientId);
  }
  if (msg.vapidPublicKey) {
    store.setVapidPublicKey(msg.vapidPublicKey);
  }
  if (msg.relayVersion) {
    store.setRelayVersion(msg.relayVersion);
  }
  // Clear transient state that may be stale from previous connection
  store.clearTransientState();
  store.setDevices(msg.devices);
  // Save device for return visits
  saveStoredDevice({ relay: transportUrl, deviceId: msg.deviceId });
  deps.setStoredDeviceId(msg.deviceId);
  // Drain any encrypted messages queued before auth
  deps.drainEncryptedQueue();
  // Session sync happens when tentacle sends session_list (triggered by device_joined)
  // Last: it may reload into the account's channel, and this device must
  // already be saved (a first pairing would otherwise be lost).
  applyAccountChannel(msg.user?.preferences);
}

/** Process auth_error: return to login page with error message. */
export function processAuthError(
  authError: { code?: string; redirect?: string; deviceId?: string; message?: string },
  storedDeviceId: string | undefined,
  deps: {
    clearStoredDeviceId: () => void;
    setStoredDeviceId: (id: string) => void;
    disconnect: () => void;
    connect: () => void;
    redirectToRelay: (url: string) => void;
    /** The relay that sent this error. */
    currentRelay: string;
  },
): void {
  const store = getStore();
  const oauthAvailable = supportsOAuthLogin(store.githubClientId);
  // The redirect is saved and then signed into with this device's key, so it
  // is followed only to a trusted relay (same rule as the Tentacle). An
  // untrusted one is handled like any other non-fatal auth error.
  if (authError.code === 'wrong_region' && authError.redirect
    && !isAcceptableRegionRedirect(deps.currentRelay, authError.redirect)) {
    logger.warn('Ignoring region redirect to an untrusted relay', authError.redirect);
  } else if (authError.code === 'wrong_region' && authError.redirect) {
    // Save new relay URL so the page reload connects to the correct region
    const deviceId = authError.deviceId ?? storedDeviceId;
    if (deviceId) {
      saveStoredDevice({ relay: authError.redirect, deviceId });
      deps.setStoredDeviceId(deviceId);
    }
    // Full page reload for a clean initialization against the new relay
    logger.info('Redirecting to assigned region', authError.redirect);
    window.location.reload();
    return;
  }

  if (storedDeviceId) {
    // Only destroy the persisted pairing on a DETERMINISTIC failure — a code
    // that proves this device's credentials are actually invalid. A transient
    // outage (auth backend unreachable/timed out → auth_unavailable, or a
    // generic auth_rejected that may itself stem from a backend hiccup) must
    // NOT clear the paired device: doing so turned a 15s account-service
    // timeout into a permanent logout that required a fresh QR/GitHub pairing.
    const fatal = authError.code === 'invalid_signature'
      || authError.code === 'account_deleted'
      || authError.code === 'device_not_found'
      || authError.code === 'unknown_device'
      || authError.code === 'user_not_found';
    if (fatal) {
      logger.warn('Auth failed for stored device (fatal), clearing credentials', { code: authError.code });
      localStorage.removeItem(STORAGE_KEY);
      deps.clearStoredDeviceId();
      store.setLastError(
        authError.code === 'account_deleted'
          ? t('settings:deletion.deleted')
          : oauthAvailable
          ? t('settings:auth.signInAgain')
          : t('settings:auth.scanAgain'),
      );
    } else {
      // Transient: keep the paired identity and just reconnect — the next
      // challenge attempt succeeds once the backend recovers.
      logger.warn('Auth failed for stored device (transient), keeping credentials', { code: authError.code });
      store.setLastError(t('settings:auth.reconnecting'));
    }
    deps.disconnect();
    deps.connect();
  } else {
    store.setReconnectState(0, null);
    store.setLastError(
      oauthAvailable
        ? t('settings:auth.signIn')
        : t('settings:auth.scan'),
    );
    store.setStatus('awaiting_login');
  }
}

/** Apply user preferences to local state. Called on auth_ok and preferences_updated. */
export function applyPreferences(prefs: Record<string, unknown> | undefined): void {
  if (!prefs) return;
  if (typeof prefs.theme === 'string' && ['light', 'dark', 'system'].includes(prefs.theme)) {
    setTheme(prefs.theme as 'light' | 'dark' | 'system');
  }
}

/** The release channel an account gets: internal accounts dogfood ("beta"). */
export function channelForAccount(prefs: Record<string, unknown> | undefined): 'beta' | 'stable' {
  return prefs?.internal === true ? 'beta' : 'stable';
}

const CHANNEL_RELOAD_KEY = 'kraki.channelReload';

/**
 * Serve the account's release channel. Called with the full account on
 * auth_ok only: `preferences_updated` can carry a partial set (an edge relay
 * knows only what was changed there), and a missing `internal` there must not
 * move an internal account to stable. The head owns `internal`; clients
 * cannot set it.
 *
 * The hosted web app is one origin; the `kraki_channel=beta` cookie makes the
 * server hand out the dogfood bundle. Kraki for Windows ships its own bundle
 * (app://) where the cookie never sticks — it gets dogfood builds through its
 * updater instead, so nothing happens there. Reloads only when the cookie
 * actually changed, and at most once per tab session per target, so a server
 * that ignores the cookie can never cause a reload loop.
 */
export function applyAccountChannel(prefs: Record<string, unknown> | undefined): void {
  setDebugLogging(prefs?.internal === true);
  if (window.krakiDesktop) return;
  const desired = channelForAccount(prefs);
  if (getCurrentChannel() === desired) {
    try { sessionStorage.removeItem(CHANNEL_RELOAD_KEY); } catch { /* storage unavailable */ }
    return;
  }
  setChannelCookie(desired);
  if (getCurrentChannel() !== desired) {
    logger.warn('Channel cookie not stored; staying on this build', { channel: desired });
    return;
  }
  let reloaded: string | null = null;
  try { reloaded = sessionStorage.getItem(CHANNEL_RELOAD_KEY); } catch { /* storage unavailable */ }
  if (reloaded === desired) {
    logger.warn('Already reloaded for this channel; staying on this build', { channel: desired });
    return;
  }
  try { sessionStorage.setItem(CHANNEL_RELOAD_KEY, desired); } catch { /* storage unavailable */ }
  logger.info('Switching release channel', { channel: desired });
  window.location.reload();
}

/** Read the current release channel from the cookie. */
export function getCurrentChannel(): string {
  return document.cookie.match(/(?:^|; )kraki_channel=([a-z]+)/)?.[1] ?? 'stable';
}

function setChannelCookie(channel: 'beta' | 'stable'): void {
  // Stable is the default: no cookie at all.
  document.cookie = channel === 'beta'
    ? `kraki_channel=beta;path=/;max-age=${365 * 86400};SameSite=Lax`
    : 'kraki_channel=;path=/;max-age=0;SameSite=Lax';
}
