/** Device presence: who joined, left, is pending or was removed, and the device list. */

import { WebSocket } from 'ws';
import type { DeviceSummary, DeviceRole, DeviceKind } from '@kraki/protocol';
import { Storage } from '../storage.js';
import type { HeadServer } from '../server.js';

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

  const summary: DeviceSummary = {
    id: device.id,
    name: device.name,
    role: device.role as DeviceRole,
    kind: (device.kind as DeviceKind) ?? undefined,
    publicKey: device.publicKey ?? undefined,
    encryptionKey: device.encryptionKey ?? undefined,
    online: true,
    lastSeen: device.lastSeen,
    createdAt: device.createdAt,
  };

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
  return stored.map(d => ({
    id: d.id,
    name: d.name,
    role: d.role as DeviceRole,
    kind: (d.kind as DeviceKind) ?? undefined,
    publicKey: d.publicKey ?? undefined,
    encryptionKey: d.encryptionKey ?? undefined,
    online: server.connections.has(d.id),
    lastSeen: d.lastSeen,
    createdAt: d.createdAt,
  }));
}
