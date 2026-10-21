/** Device presence: who joined, left, is pending or was removed, and the device list. */

import { WebSocket } from 'ws';
import type { DeviceSummary } from '@kraki/protocol';
import type { HeadServer } from '../server.js';
import type { StoredDevice } from '../storage.js';
import { deviceSummary } from '../device-summary.js';

export { deviceSummary };

/** Tell every online device of the account (the renaming one included: it is
 *  its acknowledgement) the device's new name. */
export function broadcastDeviceRenamed(server: HeadServer, userId: string, device: StoredDevice): void {
  const msg = { type: 'device_renamed', deviceId: device.id, name: device.name,
    ...(device.displayName != null && { defaultName: device.reportedName }) };
  let userDevices;
  try {
    userDevices = server.storage.getDevicesByUser(userId);
  } catch { return; }
  for (const d of userDevices) {
    const ws = server.connections.get(d.id);
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    server.sendControlToDevice(d.id, msg);
  }
}

export function broadcastDeviceRemoved(server: HeadServer, userId: string, removedDeviceId: string): void {
  let userDevices;
  try {
    userDevices = server.storage.getDevicesByUser(userId);
  } catch { return; }
  for (const d of userDevices) {
    const ws = server.connections.get(d.id);
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    server.sendPresenceToDevice(d.id, { type: 'device_removed', deviceId: removedDeviceId });
  }
}

export function broadcastDeviceJoined(server: HeadServer, userId: string, newDeviceId: string): void {
  let device;
  try {
    device = server.storage.getDevice(newDeviceId);
  } catch { return; } // Storage may be closed during shutdown
  if (!device) return;

  const summary = deviceSummary(device, true);

  let userDevices;
  try {
    userDevices = server.storage.getDevicesByUser(userId);
  } catch { return; }
  for (const d of userDevices) {
    if (d.id === newDeviceId) continue;
    const ws = server.connections.get(d.id);
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    server.sendPresenceToDevice(d.id, { type: 'device_joined', device: summary });
  }
}

export function broadcastDeviceLeft(server: HeadServer, userId: string, leftDeviceId: string): void {
  let userDevices;
  try {
    userDevices = server.storage.getDevicesByUser(userId);
  } catch { return; } // Storage may be closed during shutdown
  for (const d of userDevices) {
    if (d.id === leftDeviceId) continue;
    const ws = server.connections.get(d.id);
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    server.sendPresenceToDevice(d.id, { type: 'device_left', deviceId: leftDeviceId });
  }
}

export function broadcastDevicePending(server: HeadServer, userId: string, pendingDeviceId: string): void {
  let userDevices;
  try {
    userDevices = server.storage.getDevicesByUser(userId);
  } catch { return; }
  for (const d of userDevices) {
    if (d.id === pendingDeviceId) continue;
    const ws = server.connections.get(d.id);
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    server.sendPresenceToDevice(d.id, { type: 'device_pending', deviceId: pendingDeviceId });
  }
}

export function getDeviceSummaries(server: HeadServer, userId: string): DeviceSummary[] {
  const stored = server.storage.getDevicesByUser(userId);
  return stored.map(d => deviceSummary(d, server.connections.has(d.id)));
}
