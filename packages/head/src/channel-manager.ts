import { v4 as uuid } from 'uuid';
import type { DeviceSummary, SessionSummary, DeviceRole, DeviceKind, DeviceCapabilities } from '@kraki/protocol';
import type { AuthUser } from './auth.js';
import { Storage } from './storage.js';

export interface ConnectedDevice {
  deviceId: string;
  channelId: string;
  name: string;
  role: DeviceRole;
  kind?: DeviceKind;
  publicKey?: string;
  encryptionKey?: string;
  capabilities?: DeviceCapabilities;
  send: (data: string) => void;
}

export interface RegisterDeviceInput {
  channelId: string;
  name: string;
  role: DeviceRole;
  send: (data: string) => void;
  kind?: DeviceKind;
  publicKey?: string;
  encryptionKey?: string;
  capabilities?: DeviceCapabilities;
  /** Client-provided stable device ID for reconnection. If omitted, a new one is generated. */
  clientDeviceId?: string;
}

export interface SessionMeta {
  agent: string;
  model?: string;
}

interface SessionRecord {
  deviceId: string;
  meta: SessionMeta;
}

export class ChannelManager {
  private storage: Storage;
  /** In-memory map of connected devices by deviceId */
  private connections = new Map<string, ConnectedDevice>();
  /** Session tracking: sessionId → SessionRecord */
  private sessions = new Map<string, SessionRecord>();
  /** Reverse index: deviceId → Set of sessionIds (for fast cleanup) */
  private deviceSessions = new Map<string, Set<string>>();
  /** Per-channel seq counter */
  private seqCounters = new Map<string, number>();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * Get or create a channel for a user. Returns the channel ID.
   */
  getOrCreateChannel(user: AuthUser): string {
    this.storage.upsertUser(user.id, user.login, user.provider, user.email);
    const existing = this.storage.getChannelByOwner(user.id);
    if (existing) return existing.id;
    const channelId = `ch_${uuid().slice(0, 12)}`;
    this.storage.createChannel(channelId, user.id);
    return channelId;
  }

  /**
   * Register a device connection. Returns the assigned deviceId.
   * If clientDeviceId is provided and matches an existing device, reuses it (no ghost).
   */
  registerDevice(input: RegisterDeviceInput): string {
    const deviceId = input.clientDeviceId ?? `dev_${uuid().slice(0, 12)}`;
    this.storage.upsertDevice(deviceId, input.channelId, input.name, input.role, input.kind, input.publicKey, input.encryptionKey);
    this.connections.set(deviceId, {
      deviceId,
      channelId: input.channelId,
      name: input.name,
      role: input.role,
      kind: input.kind,
      publicKey: input.publicKey,
      encryptionKey: input.encryptionKey,
      capabilities: input.capabilities,
      send: input.send,
    });
    return deviceId;
  }

  /**
   * Remove a device connection (on disconnect).
   */
  disconnectDevice(deviceId: string): ConnectedDevice | undefined {
    const device = this.connections.get(deviceId);
    if (device) {
      this.connections.delete(deviceId);
      this.deviceSessions.delete(deviceId);
    }
    return device;
  }

  /**
   * Register that a tentacle owns a session, with metadata.
   */
  registerSession(sessionId: string, deviceId: string, meta: SessionMeta): void {
    this.sessions.set(sessionId, { deviceId, meta });
    if (!this.deviceSessions.has(deviceId)) {
      this.deviceSessions.set(deviceId, new Set());
    }
    this.deviceSessions.get(deviceId)!.add(sessionId);
    // Persist to storage for durability across restarts
    const device = this.connections.get(deviceId);
    const channelId = device?.channelId ?? this.storage.getDevice(deviceId)?.channelId;
    if (channelId) {
      this.storage.upsertSession(sessionId, channelId, deviceId, meta.agent, meta.model);
    }
  }

  /**
   * Get the tentacle deviceId that owns a session.
   * Checks in-memory first, then falls back to persistent storage.
   */
  getSessionOwner(sessionId: string): string | undefined {
    const inMemory = this.sessions.get(sessionId);
    if (inMemory) return inMemory.deviceId;
    // Check persistent storage (session may have survived a head restart)
    const stored = this.storage.getSessionById(sessionId);
    if (stored) {
      // Restore to in-memory map
      this.sessions.set(sessionId, {
        deviceId: stored.deviceId,
        meta: { agent: stored.agent, model: stored.model ?? undefined },
      });
      return stored.deviceId;
    }
    return undefined;
  }

  /**
   * Get the next seq number for a channel (monotonically increasing).
   */
  nextSeq(channelId: string): number {
    if (!this.seqCounters.has(channelId)) {
      const maxSeq = this.storage.getMaxSeq(channelId);
      this.seqCounters.set(channelId, maxSeq);
    }
    const next = this.seqCounters.get(channelId)! + 1;
    this.seqCounters.set(channelId, next);
    return next;
  }

  /**
   * Get all connected devices on a channel.
   */
  getConnectedDevices(channelId: string): ConnectedDevice[] {
    // TODO: Add channelId → Set<deviceId> index if this becomes a bottleneck
    return Array.from(this.connections.values()).filter(d => d.channelId === channelId);
  }

  /**
   * Get connected devices filtered by role.
   */
  getConnectedByRole(channelId: string, role: DeviceRole): ConnectedDevice[] {
    return this.getConnectedDevices(channelId).filter(d => d.role === role);
  }

  /**
   * Get device summaries for a channel (includes offline devices from storage).
   */
  getDeviceSummaries(channelId: string): DeviceSummary[] {
    const stored = this.storage.getDevicesByChannel(channelId);
    return stored.map(d => {
      const conn = this.connections.get(d.id);
      return {
        id: d.id,
        name: d.name,
        role: d.role as DeviceRole,
        kind: (d.kind as DeviceKind) ?? undefined,
        publicKey: d.publicKey ?? undefined,
        encryptionKey: conn?.encryptionKey ?? d.encryptionKey ?? undefined,
        online: !!conn,
        capabilities: conn?.capabilities,
      };
    });
  }

  /**
   * Get session summaries for a channel.
   */
  getSessionSummaries(channelId: string): SessionSummary[] {
    // Merge in-memory sessions with persisted sessions from storage
    const seen = new Set<string>();
    const summaries: SessionSummary[] = [];

    // In-memory sessions first (most up-to-date)
    for (const [sessionId, record] of this.sessions) {
      const conn = this.connections.get(record.deviceId);
      const channelMatch = conn
        ? conn.channelId === channelId
        : this.storage.getDevice(record.deviceId)?.channelId === channelId;
      if (channelMatch) {
        seen.add(sessionId);
        let deviceName = conn?.name;
        if (!deviceName) {
          const stored = this.storage.getDevice(record.deviceId);
          deviceName = stored?.name ?? record.deviceId;
        }
        summaries.push({
          id: sessionId,
          deviceId: record.deviceId,
          deviceName,
          agent: record.meta.agent,
          model: record.meta.model,
          messageCount: 0,
        });
      }
    }

    // Add persisted sessions not already in memory (survives head restart)
    for (const stored of this.storage.getSessionsByChannel(channelId)) {
      if (!seen.has(stored.id)) {
        const device = this.storage.getDevice(stored.deviceId);
        summaries.push({
          id: stored.id,
          deviceId: stored.deviceId,
          deviceName: device?.name ?? stored.deviceId,
          agent: stored.agent,
          model: stored.model ?? undefined,
          messageCount: 0,
        });
      }
    }

    return summaries;
  }

  /**
   * Get a specific connected device.
   */
  getConnection(deviceId: string): ConnectedDevice | undefined {
    return this.connections.get(deviceId);
  }

  /**
   * Get the underlying storage instance.
   */
  getStorage(): Storage {
    return this.storage;
  }
}
