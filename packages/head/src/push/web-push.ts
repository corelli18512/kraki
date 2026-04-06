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

    let subscription: webpush.PushSubscription;
    try {
      subscription = JSON.parse(token);
    } catch {
      logger.warn('Invalid web push subscription JSON', { tokenPrefix: token.slice(0, 30) });
      return { success: false, gone: true, error: 'Invalid subscription JSON' };
    }

    const pushPayload = JSON.stringify({
      kraki: { blob: payload.blob, key: payload.key },
    });

    try {
      await webpush.sendNotification(subscription, pushPayload, { TTL: 3600 });
      return { success: true };
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        logger.info('Web push subscription expired', { endpoint: subscription.endpoint?.slice(-30) });
        return { success: false, gone: true, error: 'Subscription expired' };
      }
      logger.warn('Web push send failed', { status: statusCode, error: (err as Error).message });
      return { success: false, error: (err as Error).message };
    }
  }
}
