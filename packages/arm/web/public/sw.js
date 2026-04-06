// Kraki Service Worker — handles push notifications
// This file must be in /public so it's served at the root scope.

self.addEventListener('push', (event) => {
  /** @type {PushEvent} */
  const pushEvent = event;

  let title = 'Kraki';
  let body = 'Needs your attention';
  let data = {};

  if (pushEvent.data) {
    try {
      const payload = pushEvent.data.json();
      // The relay sends: { kraki: { blob, key } }
      // We can't decrypt here without the private key from IndexedDB.
      // For now, show a generic notification. The app will decrypt on open.
      // Future: access IndexedDB keys from SW to decrypt pushPreview.
      if (payload.kraki) {
        data = { encrypted: true, blob: payload.kraki.blob, key: payload.kraki.key };
      }
      if (payload.title) title = payload.title;
      if (payload.body) body = payload.body;
    } catch {
      // Not JSON — use defaults
    }
  }

  const options = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data,
    tag: 'kraki-notification',
    renotify: true,
  };

  pushEvent.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  /** @type {NotificationEvent} */
  const notifEvent = event;
  notifEvent.notification.close();

  const sessionId = notifEvent.notification.data?.sessionId;
  const url = sessionId ? `/session/${sessionId}` : '/';

  notifEvent.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If Kraki is already open, focus it
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(url);
    })
  );
});
