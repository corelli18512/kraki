import type { AuthOkMessage } from '@kraki/protocol';
import type { AppKeyStore } from './e2e';
import { createLogger } from './logger';
import { getStore } from './store-adapter';
import { saveStoredDevice, STORAGE_KEY } from './transport';
import { supportsOAuthLogin } from './oauth';

const logger = createLogger('auth');

/** Send the initial auth message. Returns true if a pairing token was consumed. */
export async function sendAuth(
  send: (msg: Record<string, unknown>) => void,
  keyStore: AppKeyStore,
  pairingToken: string | undefined,
  storedDeviceId: string | undefined,
  githubCode: string | undefined,
): Promise<boolean> {
  const deviceName = `Web ${navigator.userAgent.includes('Mobile') ? 'Mobile' : 'Browser'}`;

  // Wait for key store if not ready
  if (!keyStore.isReady()) {
    try { await keyStore.init(); } catch { /* continue without E2E */ }
  }

  const publicKey = keyStore.isReady() ? await keyStore.getSigningPublicKey() : undefined;
  const encryptionKey = keyStore.isReady() ? await keyStore.getPublicKey() : undefined;

  const usedToken = !!pairingToken;
  const device = { name: deviceName, role: 'app', kind: 'web', deviceId: storedDeviceId, publicKey, encryptionKey };

  if (pairingToken) {
    send({
      type: 'auth',
      auth: { method: 'pairing', token: pairingToken },
      device,
    });
  } else if (githubCode) {
    send({
      type: 'auth',
      auth: { method: 'github_oauth', code: githubCode },
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

/** Sign and respond to an auth challenge from the head. */
export async function handleAuthChallenge(
  nonce: string,
  keyStore: AppKeyStore,
  storedDeviceId: string | undefined,
  send: (msg: Record<string, unknown>) => void,
): Promise<void> {
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
  if (msg.githubClientId) {
    store.setGithubClientId(msg.githubClientId);
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
}

/** Process auth_error: return to login page with error message. */
export function processAuthError(
  storedDeviceId: string | undefined,
  deps: {
    clearStoredDeviceId: () => void;
    disconnect: () => void;
    connect: () => void;
  },
): void {
  const store = getStore();
  const oauthAvailable = supportsOAuthLogin(store.githubClientId);
  if (storedDeviceId) {
    logger.warn('Auth failed for stored device, clearing credentials');
    localStorage.removeItem(STORAGE_KEY);
    deps.clearStoredDeviceId();
    store.setLastError(
      oauthAvailable
        ? 'Authentication failed. Please sign in again or scan a new pairing QR code.'
        : 'Authentication failed. Please scan a new pairing QR code.',
    );
    deps.disconnect();
    deps.connect();
  } else {
    store.setReconnectState(0, null);
    store.setLastError(
      oauthAvailable
        ? 'Authentication failed. Sign in with GitHub or scan a pairing QR code.'
        : 'Authentication failed. Scan a pairing QR code.',
    );
    store.setStatus('awaiting_login');
  }
}
