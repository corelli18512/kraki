import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import type { StoredMessageType } from '@kraki/protocol';

// --- Row types for SQLite result mapping ---

interface UserRow {
  user_id: string;
  username: string;
  provider: string | null;
  email: string | null;
  created_at: string;
}

interface ChannelRow {
  id: string;
  owner_id: string;
  name: string | null;
  created_at: string;
}

interface DeviceRow {
  id: string;
  channel_id: string;
  name: string;
  role: string;
  kind: string | null;
  public_key: string | null;
  encryption_key: string | null;
  last_seen: string;
  created_at: string;
}

interface MessageRow {
  id: number;
  channel_id: string;
  device_id: string;
  session_id: string | null;
  seq: number;
  type: string;
  payload: string;
  created_at: string;
}

// --- Public stored types ---

export interface StoredMessage {
  id: number;
  channelId: string;
  deviceId: string;
  sessionId: string | null;
  seq: number;
  type: string;
  payload: string;
  createdAt: string;
}

export interface StoredDevice {
  id: string;
  channelId: string;
  name: string;
  role: string;
  kind: string | null;
  publicKey: string | null;
  encryptionKey: string | null;
  lastSeen: string;
  createdAt: string;
}

export interface StoredUser {
  userId: string;
  username: string;
  provider: string;
  email?: string;
  createdAt: string;
}

export interface StoredChannel {
  id: string;
  ownerId: string;
  name: string | null;
  createdAt: string;
}

export interface StoreMessageInput {
  channelId: string;
  deviceId: string;
  sessionId: string | null;
  seq: number;
  type: string;
  payload: string;
}

const STORED_TYPES: Set<string> = new Set<string>([
  'session_created', 'session_ended',
  'user_message', 'agent_message',
  'permission', 'question',
  'tool_start', 'tool_complete',
  'error',
  'send_input', 'approve', 'deny', 'always_allow', 'answer', 'kill_session',
  'session_mode_set',
  'encrypted',
] satisfies (StoredMessageType | 'encrypted')[]);

export function shouldStore(type: string): boolean {
  return STORED_TYPES.has(type);
}

const SCHEMA_VERSION = 9;

export class Storage {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const currentVersion = (this.db.pragma('user_version', { simple: true }) as number) || 0;

    if (currentVersion < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          user_id     TEXT PRIMARY KEY,
          username    TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS channels (
          id          TEXT PRIMARY KEY,
          owner_id    TEXT NOT NULL REFERENCES users(user_id),
          name        TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS devices (
          id          TEXT PRIMARY KEY,
          channel_id  TEXT NOT NULL REFERENCES channels(id),
          name        TEXT NOT NULL,
          role        TEXT NOT NULL CHECK(role IN ('tentacle', 'app')),
          kind        TEXT,
          public_key  TEXT,
          last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- device_id intentionally has no FK to devices —
        -- messages are kept even after the device is removed
        CREATE TABLE IF NOT EXISTS messages (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id  TEXT NOT NULL REFERENCES channels(id),
          device_id   TEXT NOT NULL,
          session_id  TEXT,
          seq         INTEGER NOT NULL,
          type        TEXT NOT NULL,
          payload     TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_messages_channel_seq
          ON messages(channel_id, seq);
        CREATE INDEX IF NOT EXISTS idx_messages_session
          ON messages(channel_id, session_id, seq);
      `);
    }

    if (currentVersion < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pairing_tokens (
          token       TEXT PRIMARY KEY,
          channel_id  TEXT NOT NULL,
          expires_at  TEXT NOT NULL,
          used        INTEGER NOT NULL DEFAULT 0
        );
      `);
    }

    if (currentVersion < 3) {
      this.db.exec(`
        ALTER TABLE devices ADD COLUMN encryption_key TEXT;
      `);
    }

    if (currentVersion < 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id          TEXT PRIMARY KEY,
          channel_id  TEXT NOT NULL REFERENCES channels(id),
          device_id   TEXT NOT NULL,
          agent       TEXT NOT NULL DEFAULT 'unknown',
          model       TEXT,
          state       TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'idle', 'ended')),
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }

    if (currentVersion < 5) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS read_state (
          device_id   TEXT NOT NULL,
          session_id  TEXT NOT NULL,
          last_seq    INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (device_id, session_id)
        );
      `);
    }

    if (currentVersion < 6) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS allowed_tools (
          channel_id  TEXT NOT NULL REFERENCES channels(id),
          tool_kind   TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (channel_id, tool_kind)
        );
      `);
    }

    if (currentVersion < 7) {
      this.db.exec(`
        ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'open';
      `);
    }

    if (currentVersion < 8) {
      this.db.exec(`
        ALTER TABLE users ADD COLUMN email TEXT;
      `);
    }

    if (currentVersion < 9) {
      // Migrate read_state from per-device to per-channel (per-user)
      this.db.exec(`
        DROP TABLE IF EXISTS read_state;
        CREATE TABLE read_state (
          channel_id  TEXT NOT NULL,
          session_id  TEXT NOT NULL,
          last_seq    INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (channel_id, session_id)
        );
      `);
    }

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  // --- Users ---

  upsertUser(userId: string, username: string, provider?: string, email?: string): StoredUser {
    this.db.prepare(`
      INSERT INTO users (user_id, username, provider, email)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, provider = excluded.provider, email = excluded.email
    `).run(userId, username, provider ?? 'open', email ?? null);
    return this.getUser(userId)!;
  }

  getUser(userId: string): StoredUser | undefined {
    const row = this.db.prepare(
      'SELECT user_id, username, provider, email, created_at FROM users WHERE user_id = ?'
    ).get(userId) as UserRow | undefined;
    if (!row) return undefined;
    return { userId: row.user_id, username: row.username, provider: row.provider ?? 'open', email: row.email ?? undefined, createdAt: row.created_at };
  }

  // --- Channels ---

  createChannel(id: string, ownerId: string, name?: string): StoredChannel {
    this.db.prepare(
      'INSERT INTO channels (id, owner_id, name) VALUES (?, ?, ?)'
    ).run(id, ownerId, name ?? null);
    return this.getChannel(id)!;
  }

  getChannel(id: string): StoredChannel | undefined {
    const row = this.db.prepare(
      'SELECT id, owner_id, name, created_at FROM channels WHERE id = ?'
    ).get(id) as ChannelRow | undefined;
    if (!row) return undefined;
    return { id: row.id, ownerId: row.owner_id, name: row.name, createdAt: row.created_at };
  }

  getChannelByOwner(ownerId: string): StoredChannel | undefined {
    const row = this.db.prepare(
      'SELECT id, owner_id, name, created_at FROM channels WHERE owner_id = ?'
    ).get(ownerId) as ChannelRow | undefined;
    if (!row) return undefined;
    return { id: row.id, ownerId: row.owner_id, name: row.name, createdAt: row.created_at };
  }

  // --- Devices ---

  upsertDevice(id: string, channelId: string, name: string, role: string, kind?: string, publicKey?: string, encryptionKey?: string): StoredDevice {
    // Check for cross-channel collision: if device exists in a different channel, reject
    const existing = this.getDevice(id);
    if (existing && existing.channelId !== channelId) {
      throw new Error(`Device "${id}" belongs to channel "${existing.channelId}", not "${channelId}"`);
    }
    this.db.prepare(`
      INSERT INTO devices (id, channel_id, name, role, kind, public_key, encryption_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        kind = excluded.kind,
        public_key = excluded.public_key,
        encryption_key = excluded.encryption_key,
        last_seen = datetime('now')
    `).run(id, channelId, name, role, kind ?? null, publicKey ?? null, encryptionKey ?? null);
    return this.getDevice(id)!;
  }

  private mapDeviceRow(row: DeviceRow): StoredDevice {
    return {
      id: row.id, channelId: row.channel_id, name: row.name,
      role: row.role, kind: row.kind, publicKey: row.public_key,
      encryptionKey: row.encryption_key,
      lastSeen: row.last_seen, createdAt: row.created_at,
    };
  }

  getDevice(id: string): StoredDevice | undefined {
    const row = this.db.prepare(
      'SELECT id, channel_id, name, role, kind, public_key, encryption_key, last_seen, created_at FROM devices WHERE id = ?'
    ).get(id) as DeviceRow | undefined;
    if (!row) return undefined;
    return this.mapDeviceRow(row);
  }

  getDevicesByChannel(channelId: string): StoredDevice[] {
    const rows = this.db.prepare(
      'SELECT id, channel_id, name, role, kind, public_key, encryption_key, last_seen, created_at FROM devices WHERE channel_id = ?'
    ).all(channelId) as DeviceRow[];
    return rows.map(row => this.mapDeviceRow(row));
  }

  removeDevice(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  touchDevice(id: string): void {
    this.db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE id = ?").run(id);
  }

  // --- Sessions (persistent) ---

  upsertSession(id: string, channelId: string, deviceId: string, agent: string, model?: string): void {
    this.db.prepare(`
      INSERT INTO sessions (id, channel_id, device_id, agent, model)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        device_id = excluded.device_id,
        agent = excluded.agent,
        model = excluded.model
    `).run(id, channelId, deviceId, agent, model ?? null);
  }

  getSessionsByChannel(channelId: string): Array<{ id: string; deviceId: string; agent: string; model: string | null }> {
    return (this.db.prepare(
      'SELECT id, device_id, agent, model FROM sessions WHERE channel_id = ?'
    ).all(channelId) as Array<{ id: string; device_id: string; agent: string; model: string | null }>)
      .map(r => ({ id: r.id, deviceId: r.device_id, agent: r.agent, model: r.model }));
  }

  getSessionById(id: string): { id: string; channelId: string; deviceId: string; agent: string; model: string | null } | undefined {
    const row = this.db.prepare(
      'SELECT id, channel_id, device_id, agent, model FROM sessions WHERE id = ?'
    ).get(id) as { id: string; channel_id: string; device_id: string; agent: string; model: string | null } | undefined;
    if (!row) return undefined;
    return { id: row.id, channelId: row.channel_id, deviceId: row.device_id, agent: row.agent, model: row.model };
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  deleteSessionMessages(channelId: string, sessionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE channel_id = ? AND session_id = ?').run(channelId, sessionId);
  }

  deleteSessionReadState(channelId: string, sessionId: string): void {
    this.db.prepare('DELETE FROM read_state WHERE channel_id = ? AND session_id = ?').run(channelId, sessionId);
  }

  // --- Messages ---

  storeMessage(input: StoreMessageInput): StoredMessage {
    const info = this.db.prepare(`
      INSERT INTO messages (channel_id, device_id, session_id, seq, type, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.channelId, input.deviceId, input.sessionId, input.seq, input.type, input.payload);
    return {
      id: Number(info.lastInsertRowid),
      ...input,
      createdAt: new Date().toISOString(),
    };
  }

  private mapMessageRow(row: MessageRow): StoredMessage {
    return {
      id: row.id,
      channelId: row.channel_id,
      deviceId: row.device_id,
      sessionId: row.session_id ?? null,
      seq: row.seq,
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at,
    };
  }

  getMessagesAfterSeq(channelId: string, afterSeq: number, sessionId?: string, limit = 1000): StoredMessage[] {
    if (sessionId) {
      return (this.db.prepare(
        'SELECT * FROM messages WHERE channel_id = ? AND session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
      ).all(channelId, sessionId, afterSeq, limit) as MessageRow[]).map(row => this.mapMessageRow(row));
    }
    return (this.db.prepare(
      'SELECT * FROM messages WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    ).all(channelId, afterSeq, limit) as MessageRow[]).map(row => this.mapMessageRow(row));
  }

  /**
   * Get messages deliverable to a specific device.
   * Filters out encrypted messages where the device has no wrapped key.
   */
  getMessagesForDevice(channelId: string, afterSeq: number, deviceId: string, sessionId?: string, limit = 1000): StoredMessage[] {
    const filter = `(type != 'encrypted' OR json_extract(payload, '$.keys.' || ?) IS NOT NULL)`;
    if (sessionId) {
      return (this.db.prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND session_id = ? AND seq > ? AND ${filter} ORDER BY seq ASC LIMIT ?`
      ).all(channelId, sessionId, afterSeq, deviceId, limit) as MessageRow[]).map(row => this.mapMessageRow(row));
    }
    return (this.db.prepare(
      `SELECT * FROM messages WHERE channel_id = ? AND seq > ? AND ${filter} ORDER BY seq ASC LIMIT ?`
    ).all(channelId, afterSeq, deviceId, limit) as MessageRow[]).map(row => this.mapMessageRow(row));
  }

  /** Get the highest seq number for a channel. */
  getMaxSeq(channelId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE channel_id = ?'
    ).get(channelId) as { max_seq: number };
    return row.max_seq;
  }

  /** Delete messages with seq ≤ threshold for a channel (retention pruning). */
  pruneMessages(channelId: string, beforeSeq: number): number {
    const result = this.db.prepare(
      'DELETE FROM messages WHERE channel_id = ? AND seq <= ?'
    ).run(channelId, beforeSeq);
    return result.changes;
  }

  /** Prune messages older than a given age (in days). Returns total rows deleted. */
  pruneOldMessages(maxAgeDays = 30): number {
    const result = this.db.prepare(
      "DELETE FROM messages WHERE created_at < datetime('now', ?)"
    ).run(`-${maxAgeDays} days`);
    return result.changes;
  }

  // --- Read state ---

  /** Update the last-read seq for a channel+session pair (per-user, shared across devices) */
  markRead(channelId: string, sessionId: string, seq: number): void {
    this.db.prepare(
      'INSERT INTO read_state (channel_id, session_id, last_seq) VALUES (?, ?, ?) ON CONFLICT(channel_id, session_id) DO UPDATE SET last_seq = MAX(last_seq, ?)'
    ).run(channelId, sessionId, seq, seq);
  }

  /** Get read state for all sessions in a channel: { sessionId: lastSeq } */
  getReadState(channelId: string): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT session_id, last_seq FROM read_state WHERE channel_id = ?'
    ).all(channelId) as { session_id: string; last_seq: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.session_id] = row.last_seq;
    }
    return result;
  }

  /** Get the max seq per session in a channel (for computing unread counts) */
  getSessionMaxSeqs(channelId: string): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT session_id, MAX(seq) as max_seq FROM messages WHERE channel_id = ? AND session_id IS NOT NULL GROUP BY session_id'
    ).all(channelId) as { session_id: string; max_seq: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.session_id] = row.max_seq;
    }
    return result;
  }

  // --- Pairing tokens ---

  /**
   * Store a pairing token. The token is hashed before storage —
   * if the DB is compromised, the attacker only gets a hash.
   */
  createPairingToken(token: string, channelId: string, expiresAt: string): void {
    const hashed = this.hashToken(token);
    this.db.prepare(
      'INSERT INTO pairing_tokens (token, channel_id, expires_at) VALUES (?, ?, ?)'
    ).run(hashed, channelId, expiresAt);
  }

  /**
   * Validate and consume a pairing token. Returns channelId if valid.
   * Token is single-use and time-limited.
   */
  consumePairingToken(token: string): string | null {
    const hashed = this.hashToken(token);
    const row = this.db.prepare(
      'SELECT channel_id, expires_at, used FROM pairing_tokens WHERE token = ?'
    ).get(hashed) as { channel_id: string; expires_at: string; used: number } | undefined;

    if (!row) return null;
    if (row.used) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    this.db.prepare('UPDATE pairing_tokens SET used = 1 WHERE token = ?').run(hashed);
    return row.channel_id;
  }

  /**
   * Clean up expired pairing tokens.
   */
  cleanExpiredPairingTokens(): number {
    const now = new Date().toISOString();
    const info = this.db.prepare(
      'DELETE FROM pairing_tokens WHERE expires_at < ? OR used = 1'
    ).run(now);
    return info.changes;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // --- Cleanup ---

  // TODO: Add deleteMessagesBeforeSeq(channelId, seq) for message retention
  // TODO: Add configurable max messages per channel with auto-pruning

  close(): void {
    this.db.close();
  }
}
