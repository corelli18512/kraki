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

// ── Push event handler ──────────────────────────────────

self.addEventListener('push', (event) => {
  const handlePush = async () => {
    let title = 'Kraki';
    let body = 'Needs your attention';
    let data = {};

    if (event.data) {
      try {
        const payload = event.data.json();
        if (payload.kraki) {
          try {
            const preview = await decryptPreview(payload.kraki.blob, payload.kraki.key);
            if (preview) {
              body = formatBody(preview);
              if (preview.sessionId) data.sessionId = preview.sessionId;
            }
          } catch {
            // Decryption failed — use generic message
          }
        }
      } catch {
        // Not JSON — use defaults
      }
    }

    return self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data,
      tag: 'kraki-notification',
      renotify: true,
    });
  };

  event.waitUntil(handlePush());
});

// ── Notification click handler ──────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const path = sessionId ? `/session/${sessionId}` : '/';
  const fullUrl = self.registration.scope + path.slice(1);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(fullUrl);
    })
  );
});
