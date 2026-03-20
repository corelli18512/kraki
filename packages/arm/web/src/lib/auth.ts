import type { AppKeyStore } from './e2e';
import { getStore } from './store-adapter';
import { saveStoredDevice, STORAGE_KEY } from './transport';

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

  if (pairingToken) {
    send({
      type: 'auth',
      pairingToken,
      device: { name: deviceName, role: 'app', kind: 'web', deviceId: storedDeviceId, publicKey, encryptionKey },
    });
  } else if (githubCode) {
    send({
      type: 'auth',
      githubCode,
      device: { name: deviceName, role: 'app', kind: 'web', publicKey, encryptionKey },
    });
  } else if (storedDeviceId) {
    send({
      type: 'auth',
      device: { name: deviceName, role: 'app', kind: 'web', deviceId: storedDeviceId, publicKey, encryptionKey },
    });
  } else {
    send({
      type: 'auth',
      device: { name: deviceName, role: 'app', kind: 'web', publicKey, encryptionKey },
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
    if (import.meta.env.DEV) {
      console.error('[Kraki] Challenge signing failed:', err);
    }
    // Can't sign — need to re-pair
    getStore().setStatus('error');
  }
}

/** Process auth_ok: populate store, save device, drain encrypted queue, start replay. */
export function processAuthOk(
  msg: any,
  transportUrl: string,
  deps: {
    setStoredDeviceId: (id: string) => void;
    setE2eEnabled: (v: boolean) => void;
    setReadState: (rs: Record<string, number>) => void;
    drainEncryptedQueue: () => void;
    send: (msg: Record<string, unknown>) => void;
    startReplay: () => void;
  },
): void {
  const store = getStore();
  store.setStatus('connected');
  store.setAuth(msg.channel, msg.deviceId);
  store.setUser((msg as any).user ?? null);
  if ((msg as any).githubClientId) {
    store.setGithubClientId((msg as any).githubClientId);
  }
  store.setSessions(msg.sessions);
  store.setDevices(msg.devices);
  deps.setE2eEnabled(msg.e2e);
  // Store read state for computing unread after replay
  deps.setReadState((msg as any).readState ?? {});
  // Save device for return visits
  saveStoredDevice({ relay: transportUrl, deviceId: msg.deviceId });
  deps.setStoredDeviceId(msg.deviceId);
  // Drain any encrypted messages queued before auth
  deps.drainEncryptedQueue();
  // Replay messages (always request full replay on fresh load)
  deps.startReplay();
}

/** Process auth_error: clear stored device and reconnect, or set error status. */
export function processAuthError(
  storedDeviceId: string | undefined,
  deps: {
    clearStoredDeviceId: () => void;
    disconnect: () => void;
    connect: () => void;
  },
): void {
  const store = getStore();
  if (storedDeviceId) {
    // Challenge-response failed (keys changed or device removed)
    console.warn('[Kraki] Auth failed for stored device, clearing credentials');
    localStorage.removeItem(STORAGE_KEY);
    deps.clearStoredDeviceId();
    store.setLastError('Authentication failed. Please sign in again or scan a new pairing QR code.');
    store.setStatus('error');
  } else {
    store.setLastError('Authentication failed. Sign in with GitHub or scan a pairing QR code.');
    store.setStatus('error');
  }
}
