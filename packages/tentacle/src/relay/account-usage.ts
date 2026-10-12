/** Account usage: the latest reading, refresh requests, usage history. */

import type { ProducerMessage } from '@kraki/protocol';
import { RelayClient } from '../relay-client.js';

export function accountUsageMessage(client: RelayClient) {
  return {
    type: 'device_usage' as const,
    deviceId: client.authInfo?.deviceId ?? '',
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: { accounts: client.accountUsage ?? [], updatedAt: new Date().toISOString() },
  };
}

export function broadcastAccountUsage(client: RelayClient): void {
  if (!client.accountUsage) return;
  client.sendEncrypted(accountUsageMessage(client) as Partial<ProducerMessage>);
}

export function sendAccountUsageTo(client: RelayClient, targetDeviceId: string, compactPubKey: string): void {
  if (!client.accountUsage) return;
  client.sendReliableUnicastTo(targetDeviceId, compactPubKey, accountUsageMessage(client));
}

export async function handleRefreshAccountUsage(client: RelayClient, requesterDeviceId: string, requestId: unknown): Promise<void> {
  const key = client.consumerKeys.get(requesterDeviceId);
  if (!key || typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(requestId)) return;
  const reply = (error?: 'unavailable' | 'disabled' | 'busy') => {
    if (client.state !== 'connected' || !client.isAppOnline(requesterDeviceId)
      || client.consumerKeys.get(requesterDeviceId) !== key) return;
    const message = accountUsageMessage(client);
    client.sendReliableUnicastTo(requesterDeviceId, key, {
      ...message, payload: { ...message.payload, requestId, ...(error && { refreshError: error }) },
    });
  };
  if (!client.accountUsageEnabled || !client.accountUsageRefresher) { reply('disabled'); return; }
  // Bound pending replies to one per authenticated device, and share the
  // actual read across devices. The monitor also enforces provider cooldowns.
  if (client.usageRefreshRequests.has(requesterDeviceId)) { reply('busy'); return; }
  client.usageRefreshRequests.set(requesterDeviceId, requestId);
  try {
    client.usageRefreshInFlight ??= Promise.resolve().then(() => client.accountUsageRefresher!())
      .finally(() => { client.usageRefreshInFlight = null; });
    client.accountUsage = await client.usageRefreshInFlight;
    reply(); // Even an unchanged/throttled read must complete the UI request.
  } catch {
    reply('unavailable'); // Never forward provider exception bodies or credentials.
  } finally {
    client.usageRefreshRequests.delete(requesterDeviceId);
  }
}

export function handleRequestUsageHistory(client: RelayClient, requesterDeviceId: string, since?: number): void {
  const key = client.consumerKeys.get(requesterDeviceId);
  if (!key) return;
  const floor = typeof since === 'number' && Number.isFinite(since) ? since : Date.now() / 1000 - 60 * 86400;
  let samples = client.usageHistoryReader?.(floor) ?? [];
  const truncated = samples.length > RelayClient.USAGE_HISTORY_MAX_SAMPLES;
  if (truncated) samples = samples.slice(-RelayClient.USAGE_HISTORY_MAX_SAMPLES);
  client.sendReliableUnicastTo(requesterDeviceId, key, {
    type: 'usage_history',
    deviceId: client.authInfo?.deviceId ?? '',
    seq: ++client.seqCounter,
    timestamp: new Date().toISOString(),
    payload: { samples, ...(truncated && { truncated: true }) },
  });
}
