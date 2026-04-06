// ------------------------------------------------------------
// PushManager — coordinates push providers and token storage
// ------------------------------------------------------------

import { getLogger } from '../logger.js';
import type { Storage, StoredPushToken } from '../storage.js';
import type { PushProvider } from './provider.js';
import type { BlobPayload } from '@kraki/protocol';

export class PushManager {
  private providers = new Map<string, PushProvider>();

  constructor(
    private storage: Storage,
    providers: PushProvider[],
  ) {
    for (const p of providers) {
      this.providers.set(p.name, p);
    }
  }

  /** Send push notifications to all offline devices with registered tokens. */
  async sendToOfflineDevices(
    userId: string,
    onlineDeviceIds: string[],
    pushPreview: BlobPayload,
  ): Promise<void> {
    const logger = getLogger();
    const tokens = this.storage.getPushTokensForOfflineDevices(userId, onlineDeviceIds);

    if (tokens.length === 0) return;

    const results = await Promise.allSettled(
      tokens.map(token => this.sendToDevice(token, pushPreview)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const token = tokens[i];
      if (result.status === 'rejected') {
        logger.warn('Push send threw unexpectedly', { deviceId: token.deviceId, provider: token.provider, error: result.reason });
      }
    }
  }

  private async sendToDevice(storedToken: StoredPushToken, pushPreview: BlobPayload): Promise<void> {
    const logger = getLogger();
    const provider = this.providers.get(storedToken.provider);
    if (!provider) {
      logger.debug('No push provider for type', { provider: storedToken.provider });
      return;
    }

    const deviceKey = pushPreview.keys[storedToken.deviceId];
    if (!deviceKey) {
      logger.debug('No push preview key for device', { deviceId: storedToken.deviceId });
      return;
    }

    const result = await provider.send(
      storedToken.token,
      { blob: pushPreview.blob, key: deviceKey },
      { environment: storedToken.environment ?? undefined, bundleId: storedToken.bundleId ?? undefined },
    );

    if (result.gone) {
      this.storage.deletePushToken(storedToken.deviceId, storedToken.provider);
      logger.info('Removed stale push token', { deviceId: storedToken.deviceId, provider: storedToken.provider });
    }
  }

  close(): void {
    for (const provider of this.providers.values()) {
      provider.close?.();
    }
  }

  /** Get the VAPID public key if a web_push provider is configured. */
  getVapidPublicKey(): string | undefined {
    const wp = this.providers.get('web_push') as { vapidPublicKey?: string } | undefined;
    return wp?.vapidPublicKey;
  }
}

export { type PushProvider, type PushPayload, type PushResult } from './provider.js';
export { ApnsProvider, type ApnsConfig } from './apns.js';
export { WebPushProvider, type WebPushConfig } from './web-push.js';
