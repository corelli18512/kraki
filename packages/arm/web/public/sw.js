// Kraki Service Worker — push notifications and the offline app shell.
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

// ── Localized notification text ─────────────────────────
// The worker cannot load the app's locales. These mirror
// desktop.agents.attention / desktop.notifications.permission in
// src/i18n/locales (a test keeps them equal). The page registers the worker
// as /sw.js?lang=<app language>; without it the browser languages decide.

const STRINGS = {
  en: { attention: 'Needs attention', permission: 'Needs approval: {{summary}}' },
  'zh-Hans': { attention: '需要处理', permission: '需要批准：{{summary}}' },
};

function workerLanguage() {
  const lang = new URL(self.location.href).searchParams.get('lang');
  if (lang && STRINGS[lang]) return lang;
  const tags = (self.navigator && self.navigator.languages) || [];
  for (const tag of tags) {
    const parts = String(tag).toLowerCase().split(/[-_]/);
    if (parts[0] === 'zh') {
      if (parts.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo')) continue;
      return 'zh-Hans';
    }
    if (parts[0] === 'en') return 'en';
  }
  return 'en';
}

function text(key, summary) {
  return STRINGS[workerLanguage()][key].replace('{{summary}}', summary || '');
}

// ── Format notification body from preview ───────────────

function formatBody(preview) {
  if (!preview || !preview.summary) return text('attention');
  if (preview.type === 'permission') return text('permission', preview.summary);
  return preview.summary;
}

// ── Push event handler ──────────────────────────────────

self.addEventListener('push', (event) => {
  const handlePush = async () => {
    let title = 'Kraki';
    let body = text('attention');
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
  // `from=notification`: the chat lands on the first new message even if the
  // cached list doesn't know yet that the Session has new messages.
  const path = sessionId ? `/session/${sessionId}?from=notification` : '/';
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

// ── Offline app shell ───────────────────────────────────
// Without a fetch handler a Home Screen web app showed the browser's error
// page offline (K-112). Pages are network-first: online, every load gets the
// current deploy; offline, the last page seen is served, and the app shows
// its own "can't connect" state over the cached sessions. Built assets are
// content-hashed (immutable), so they are served from the cache once seen.

const SHELL_CACHE = 'kraki-shell-v1';
const SHELL_KEY = '/';
const MAX_ASSETS = 120;

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('kraki-shell-') && key !== SHELL_CACHE).map((key) => caches.delete(key)),
  )));
});

async function pageResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(SHELL_KEY, response.clone());
    return response;
  } catch (err) {
    const shell = await cache.match(SHELL_KEY);
    if (shell) return shell;
    throw err;
  }
}

async function assetResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
    const keys = (await cache.keys()).filter((key) => new URL(key.url).pathname.startsWith('/assets/'));
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((key) => cache.delete(key)));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(pageResponse(request));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(assetResponse(request));
  }
});
