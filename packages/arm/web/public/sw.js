// Kraki Service Worker — handles push notifications
// This file must be in /public so it's served at the root scope.

// ── IndexedDB helpers (same DB as e2e.ts) ───────────────

const DB_NAME = 'kraki-keys';
const STORE_NAME = 'keypair';
const ENCRYPT_KEY_ID = 'device-encrypt-key';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Base64 helpers ──────────────────────────────────────

function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Decrypt pushPreview blob ────────────────────────────

async function decryptPreview(blob, wrappedKeyB64) {
  const db = await openDB();
  const encryptKeyPair = await idbGet(db, ENCRYPT_KEY_ID);
  db.close();

  if (!encryptKeyPair) return null;

  const wrappedKey = base64ToUint8(wrappedKeyB64);
  const aesKeyRaw = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    encryptKeyPair.privateKey,
    wrappedKey,
  );

  const aesKey = await crypto.subtle.importKey(
    'raw', aesKeyRaw, { name: 'AES-GCM' }, false, ['decrypt'],
  );

  const raw = base64ToUint8(blob);
  const iv = raw.slice(0, 12);
  const cipherAndTag = raw.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    cipherAndTag,
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}

// ── Format notification body from preview ───────────────

function formatBody(preview) {
  if (!preview || !preview.summary) return 'Needs your attention';
  if (preview.type === 'permission') return 'Permission needed: ' + preview.summary;
  return preview.summary;
}

// ── Which Session is on screen ──────────────────────────

/** The Session open in a window the user is looking at (visible and
 *  focused), or null. */
async function sessionOnScreen() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    if (!client.focused || client.visibilityState !== 'visible') continue;
    const prefix = new URL('session/', self.registration.scope).pathname;
    const path = new URL(client.url).pathname;
    if (path.startsWith(prefix)) return decodeURIComponent(path.slice(prefix.length).split('/')[0]);
  }
  return null;
}

// ── Push event handler ──────────────────────────────────

// A connected tab tells the Head whether the user is looking at it
// (ws-client.ts reportAppVisibility), so pushes arrive while it is hidden or
// unfocused. A push that races the tab coming back to the Session it is
// about is left out.
self.addEventListener('push', (event) => {
  const handlePush = async () => {
    let title = 'Kraki';
    let body = 'Needs your attention';
    let data = {};
    let nid;

    if (event.data) {
      try {
        const payload = event.data.json();
        if (payload.kraki) {
          try {
            const preview = await decryptPreview(payload.kraki.blob, payload.kraki.key);
            if (preview) {
              body = formatBody(preview);
              if (preview.sessionId) data.sessionId = preview.sessionId;
              if (typeof preview.nid === 'string') nid = preview.nid;
            }
          } catch {
            // Decryption failed — use generic message
          }
        }
      } catch {
        // Not JSON — use defaults
      }
    }

    if (data.sessionId && await sessionOnScreen() === data.sessionId) return;

    // One notification per preview: a shared tag made a reply replace a
    // pending question. The preview id still collapses the same preview
    // delivered twice.
    return self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data,
      ...(nid ? { tag: 'kraki-' + nid } : {}),
    });
  };

  event.waitUntil(handlePush());
});

// ── Notification click handler ──────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  // `from=notification`: the chat lands on the first new message even if the
  // cached list doesn't know yet that the Session has new messages.
  const path = sessionId ? `/session/${sessionId}?from=notification` : '/';
  const fullUrl = self.registration.scope + path.slice(1);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          // An open tab opens the Session itself (App.tsx), without a reload.
          if (sessionId) client.postMessage({ type: 'kraki:open-session', sessionId });
          return client.focus();
        }
      }
      return self.clients.openWindow(fullUrl);
    })
  );
});
