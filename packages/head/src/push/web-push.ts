// ------------------------------------------------------------
// Web Push provider — VAPID + web-push library
// ------------------------------------------------------------

import webpush from 'web-push';
import { getLogger } from '../logger.js';
import type { PushPayload, PushProvider, PushResult } from './provider.js';

export interface WebPushConfig {
  /** VAPID public key (base64url) */
  vapidPublicKey: string;
  /** VAPID private key (base64url) */
  vapidPrivateKey: string;
  /** Contact email for VAPID (e.g. "mailto:admin@kraki.dev") */
  vapidEmail: string;
}

/**
 * Hosts of the browser push services a Web Push subscription may point at:
 * Chromium browsers (FCM, plus the legacy GCM host of very old
 * subscriptions), Firefox (Mozilla autopush), Safari (Apple Web Push) and
 * Edge (WNS). The relay POSTs to the endpoint, so any other host is refused.
 */
const WEB_PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com'];
const WEB_PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

/** Whether `endpoint` is an https URL on a known browser push service. */
export function isAllowedWebPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string') return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return WEB_PUSH_HOSTS.includes(host) || WEB_PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** The subscription in a stored `web_push` token, or null when it is not
 *  JSON or its endpoint is not a known push service. */
export function parseWebPushSubscription(token: string): webpush.PushSubscription | null {
  let subscription: unknown;
  try { subscription = JSON.parse(token); } catch { return null; }
  if (typeof subscription !== 'object' || subscription === null) return null;
  const endpoint = (subscription as { endpoint?: unknown }).endpoint;
  return isAllowedWebPushEndpoint(endpoint) ? subscription as webpush.PushSubscription : null;
}

export class WebPushProvider implements PushProvider {
  readonly name = 'web_push';
  readonly vapidPublicKey: string;

  constructor(config: WebPushConfig) {
    this.vapidPublicKey = config.vapidPublicKey;
    webpush.setVapidDetails(
      config.vapidEmail,
      config.vapidPublicKey,
      config.vapidPrivateKey,
    );
  }

  async send(token: string, payload: PushPayload): Promise<PushResult> {
    const logger = getLogger();

    // Rows stored before registration checked the endpoint are dropped here.
    const subscription = parseWebPushSubscription(token);
    if (!subscription) {
      logger.warn('Invalid web push subscription');
      return { success: false, gone: true, error: 'Invalid subscription' };
    }

    const pushPayload = JSON.stringify({
      kraki: { blob: payload.blob, key: payload.key },
    });

    try {
      await webpush.sendNotification(subscription, pushPayload, { TTL: 3600 });
      return { success: true };
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      const body = (err as { body?: string }).body;
      if (statusCode === 404 || statusCode === 410) {
        logger.info('Web push subscription expired', { endpoint: subscription.endpoint?.slice(-30) });
        return { success: false, gone: true, error: 'Subscription expired' };
      }
      logger.warn('Web push send failed', {
        status: statusCode,
        error: (err as Error).message || body || String(err),
      });
      return { success: false, error: (err as Error).message || body || 'Unknown error' };
    }
  }
}
