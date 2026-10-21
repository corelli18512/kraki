/** A stored device as the account's other devices see it. */

import type { DeviceSummary, DeviceRole, DeviceKind } from '@kraki/protocol';
import type { StoredDevice } from './storage.js';

/** The device as other devices see it: custom name first. */
export function deviceSummary(device: StoredDevice, online: boolean): DeviceSummary {
  return {
    id: device.id,
    name: device.name,
    ...(device.displayName != null && { defaultName: device.reportedName }),
    role: device.role as DeviceRole,
    kind: (device.kind as DeviceKind) ?? undefined,
    publicKey: device.publicKey ?? undefined,
    encryptionKey: device.encryptionKey ?? undefined,
    online,
    lastSeen: device.lastSeen,
    createdAt: device.createdAt,
  };
}
