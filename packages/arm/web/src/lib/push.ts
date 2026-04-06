/**
 * Web Push notification subscription management.
 *
 * Registers a service worker, subscribes to push, and sends the
 * subscription to the relay via register_push_token.
 */

import { createLogger } from './logger';

const logger = createLogger('push');

/** Check if push notifications are supported in this browser. */
export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/** Get the current notification permission state. */
export function getPushPermission(): NotificationPermission {
  if (!('Notification' in window)) return 'denied';
  return Notification.permission;
}

/** Check if push is currently subscribed (has an active subscription). */
export async function isPushSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub !== null;
  } catch {
    return false;
  }
}

/**
 * Subscribe to push notifications.
 * Returns the subscription JSON string (to send as push token), or null on failure.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<string | null> {
  if (!isPushSupported()) {
    logger.warn('Push not supported in this browser');
    return null;
  }

  // Request permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    logger.info('Push notification permission denied');
    return null;
  }

  try {
    // Register service worker
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    // Convert VAPID key from base64url to Uint8Array
    const vapidKeyBytes = urlBase64ToUint8Array(vapidPublicKey);

    // Subscribe
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKeyBytes,
    });

    const token = JSON.stringify(subscription.toJSON());
    logger.info('Push subscription created');
    return token;
  } catch (err) {
    logger.error('Push subscription failed', { error: (err as Error).message });
    return null;
  }
}

/**
 * Unsubscribe from push notifications.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  if (!isPushSupported()) return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe();
      logger.info('Push subscription removed');
      return true;
    }
    return false;
  } catch (err) {
    logger.error('Push unsubscribe failed', { error: (err as Error).message });
    return false;
  }
}

// Convert base64url VAPID key to Uint8Array for applicationServerKey
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
