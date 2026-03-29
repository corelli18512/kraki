import Database from 'better-sqlite3';

// --- Row types for SQLite result mapping ---

interface UserRow {
  user_id: string;
  username: string;
  provider: string;
  email: string | null;
  preferences: string | null;
  created_at: string;
}

interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  role: string;
  kind: string | null;
  public_key: string | null;
  encryption_key: string | null;
  last_seen: string;
  created_at: string;
}

// --- Public stored types ---

export interface StoredDevice {
  id: string;
  userId: string;
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
  preferences?: Record<string, unknown>;
  createdAt: string;
}

const SCHEMA_VERSION = 2;

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
          provider    TEXT NOT NULL DEFAULT 'open',
          email       TEXT,
          preferences TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS devices (
          id              TEXT PRIMARY KEY,
          user_id         TEXT NOT NULL REFERENCES users(user_id),
          name            TEXT NOT NULL,
          role            TEXT NOT NULL CHECK(role IN ('tentacle', 'app')),
          kind            TEXT,
          public_key      TEXT,
          encryption_key  TEXT,
          last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }

    if (currentVersion < 2) {
      // Add preferences column if upgrading from v1
      try {
        this.db.exec(`ALTER TABLE users ADD COLUMN preferences TEXT`);
      } catch {
        // Column may already exist from v1 schema above
      }
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
      'SELECT user_id, username, provider, email, preferences, created_at FROM users WHERE user_id = ?'
    ).get(userId) as UserRow | undefined;
    if (!row) return undefined;
    let prefs: Record<string, unknown> | undefined;
    if (row.preferences) {
      try { prefs = JSON.parse(row.preferences); } catch { /* ignore */ }
    }
    return { userId: row.user_id, username: row.username, provider: row.provider, email: row.email ?? undefined, preferences: prefs, createdAt: row.created_at };
  }

  updatePreferences(userId: string, preferences: Record<string, unknown>): void {
    const existing = this.getUser(userId);
    if (!existing) return;
    const merged = { ...(existing.preferences ?? {}), ...preferences };
    this.db.prepare('UPDATE users SET preferences = ? WHERE user_id = ?')
      .run(JSON.stringify(merged), userId);
  }

  // --- Devices ---

  upsertDevice(id: string, userId: string, name: string, role: string, kind?: string, publicKey?: string, encryptionKey?: string): StoredDevice {
    const existing = this.getDevice(id);
    if (existing && existing.userId !== userId) {
      throw new Error(`Device "${id}" belongs to user "${existing.userId}", not "${userId}"`);
    }
    this.db.prepare(`
      INSERT INTO devices (id, user_id, name, role, kind, public_key, encryption_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        kind = excluded.kind,
        public_key = excluded.public_key,
        encryption_key = excluded.encryption_key,
        last_seen = datetime('now')
    `).run(id, userId, name, role, kind ?? null, publicKey ?? null, encryptionKey ?? null);
    return this.getDevice(id)!;
  }

  getDevice(id: string): StoredDevice | undefined {
    const row = this.db.prepare(
      'SELECT id, user_id, name, role, kind, public_key, encryption_key, last_seen, created_at FROM devices WHERE id = ?'
    ).get(id) as DeviceRow | undefined;
    if (!row) return undefined;
    return this.mapDeviceRow(row);
  }

  getDevicesByUser(userId: string): StoredDevice[] {
    const rows = this.db.prepare(
      'SELECT id, user_id, name, role, kind, public_key, encryption_key, last_seen, created_at FROM devices WHERE user_id = ?'
    ).all(userId) as DeviceRow[];
    return rows.map(row => this.mapDeviceRow(row));
  }

  private mapDeviceRow(row: DeviceRow): StoredDevice {
    return {
      id: row.id, userId: row.user_id, name: row.name,
      role: row.role, kind: row.kind, publicKey: row.public_key,
      encryptionKey: row.encryption_key,
      lastSeen: row.last_seen, createdAt: row.created_at,
    };
  }

  deleteDevice(id: string): boolean {
    const result = this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // --- Cleanup ---

  close(): void {
    this.db.close();
  }
}
