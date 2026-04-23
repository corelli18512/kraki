import { createHash, randomBytes } from 'crypto';
import Database from 'better-sqlite3';

// --- Row types for SQLite result mapping ---

interface UserRow {
  user_id: string;
  username: string;
  provider: string;
  email: string | null;
  preferences: string | null;
  region: string | null;
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

interface RegionRow {
  code: string;
  relay_url: string;
  display_name: string | null;
  enabled: number;
  registered_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

interface EdgeJoinTokenRow {
  token_hash: string;
  region: string;
  relay_url: string;
  display_name: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

interface EdgeServiceRow {
  region: string;
  service_key_hash: string;
  issued_at: string;
  last_seen_at: string | null;
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

export interface StoredPushToken {
  deviceId: string;
  provider: string;
  token: string;
  environment: string | null;
  bundleId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredUser {
  userId: string;
  username: string;
  provider: string;
  email?: string;
  preferences?: Record<string, unknown>;
  region?: string;
  createdAt: string;
}

export interface StoredRegion {
  code: string;
  relayUrl: string;
  displayName?: string;
  enabled: boolean;
  registeredAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

const SCHEMA_VERSION = 7;

export class Storage {
  private db: Database.Database;

  private static hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  private static normalizeRegionCode(region: string): string {
    const value = region.trim().toLowerCase();
    if (!value) throw new Error('Region code is required');
    if (!/^[a-z0-9_-]+$/.test(value)) {
      throw new Error(`Invalid region code "${region}". Use letters, numbers, - or _.`);
    }
    return value;
  }

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

    if (currentVersion < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_messages (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          target_device_id  TEXT NOT NULL,
          user_id           TEXT NOT NULL,
          envelope          TEXT NOT NULL,
          created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_pending_target ON pending_messages(target_device_id);
      `);
    }

    if (currentVersion < 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS push_tokens (
          device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          provider    TEXT NOT NULL,
          token       TEXT NOT NULL,
          environment TEXT,
          bundle_id   TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (device_id, provider)
        );
      `);
    }

    if (currentVersion < 5) {
      try {
        this.db.exec(`ALTER TABLE users ADD COLUMN region TEXT`);
      } catch {
        // Column may already exist
      }
    }

    if (currentVersion < 6) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS regions (
          code          TEXT PRIMARY KEY,
          relay_url     TEXT NOT NULL,
          display_name  TEXT,
          enabled       INTEGER NOT NULL DEFAULT 1,
          registered_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_regions_enabled ON regions(enabled);

        CREATE TABLE IF NOT EXISTS edge_join_tokens (
          token_hash    TEXT PRIMARY KEY,
          region        TEXT,
          relay_url     TEXT,
          display_name  TEXT,
          expires_at    TEXT NOT NULL,
          used_at       TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_edge_join_tokens_expires ON edge_join_tokens(expires_at);

        CREATE TABLE IF NOT EXISTS edge_services (
          region            TEXT PRIMARY KEY,
          service_key_hash  TEXT NOT NULL,
          issued_at         TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at      TEXT
        );
      `);
    }

    if (currentVersion < 7) {
      // Make region and relay_url nullable (edge provides them at join time)
      try {
        const rows = this.db.prepare('SELECT token_hash, region, relay_url, display_name, expires_at, used_at, created_at FROM edge_join_tokens').all();
        this.db.exec('DROP TABLE IF EXISTS edge_join_tokens');
        this.db.exec(`
          CREATE TABLE edge_join_tokens (
            token_hash    TEXT PRIMARY KEY,
            region        TEXT,
            relay_url     TEXT,
            display_name  TEXT,
            expires_at    TEXT NOT NULL,
            used_at       TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_edge_join_tokens_expires ON edge_join_tokens(expires_at);
        `);
        const ins = this.db.prepare('INSERT INTO edge_join_tokens (token_hash, region, relay_url, display_name, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const row of rows as Array<{ token_hash: string; region: string | null; relay_url: string | null; display_name: string | null; expires_at: string; used_at: string | null; created_at: string }>) {
          ins.run(row.token_hash, row.region, row.relay_url, row.display_name, row.expires_at, row.used_at, row.created_at);
        }
      } catch {
        // Table may not exist yet on fresh DBs
      }
    }

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  // --- Users ---

  upsertUser(userId: string, username: string, provider?: string, email?: string, region?: string): StoredUser {
    this.db.prepare(`
      INSERT INTO users (user_id, username, provider, email, region)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, provider = excluded.provider, email = excluded.email
    `).run(userId, username, provider ?? 'open', email ?? null, region ?? null);
    return this.getUser(userId)!;
  }

  getUser(userId: string): StoredUser | undefined {
    const row = this.db.prepare(
      'SELECT user_id, username, provider, email, preferences, region, created_at FROM users WHERE user_id = ?'
    ).get(userId) as UserRow | undefined;
    if (!row) return undefined;
    let prefs: Record<string, unknown> | undefined;
    if (row.preferences) {
      try { prefs = JSON.parse(row.preferences); } catch { /* ignore */ }
    }
    return { userId: row.user_id, username: row.username, provider: row.provider, email: row.email ?? undefined, preferences: prefs, region: row.region ?? undefined, createdAt: row.created_at };
  }

  setUserRegion(userId: string, region: string): void {
    this.db.prepare('UPDATE users SET region = ? WHERE user_id = ?').run(region, userId);
  }

  updatePreferences(userId: string, preferences: Record<string, unknown>): void {
    const existing = this.getUser(userId);
    if (!existing) return;
    const merged = { ...(existing.preferences ?? {}), ...preferences };
    this.db.prepare('UPDATE users SET preferences = ? WHERE user_id = ?')
      .run(JSON.stringify(merged), userId);
  }

  // --- Region registry ---

  upsertRegion(code: string, relayUrl: string, displayName?: string, enabled = true): StoredRegion {
    const normalizedCode = Storage.normalizeRegionCode(code);
    const trimmedRelayUrl = relayUrl.trim();
    if (!trimmedRelayUrl) throw new Error('Relay URL is required');

    this.db.prepare(`
      INSERT INTO regions (code, relay_url, display_name, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        relay_url = excluded.relay_url,
        display_name = excluded.display_name,
        enabled = excluded.enabled,
        updated_at = datetime('now')
    `).run(normalizedCode, trimmedRelayUrl, displayName ?? null, enabled ? 1 : 0);

    return this.getRegion(normalizedCode)!;
  }

  getRegion(code: string): StoredRegion | undefined {
    const row = this.db.prepare(`
      SELECT code, relay_url, display_name, enabled, registered_at, updated_at, last_seen_at
      FROM regions WHERE code = ?
    `).get(Storage.normalizeRegionCode(code)) as RegionRow | undefined;
    if (!row) return undefined;
    return this.mapRegionRow(row);
  }

  getRegions(enabledOnly = false): StoredRegion[] {
    const rows = enabledOnly
      ? this.db.prepare(`
          SELECT code, relay_url, display_name, enabled, registered_at, updated_at, last_seen_at
          FROM regions WHERE enabled = 1 ORDER BY code
        `).all()
      : this.db.prepare(`
          SELECT code, relay_url, display_name, enabled, registered_at, updated_at, last_seen_at
          FROM regions ORDER BY code
        `).all();
    return (rows as RegionRow[]).map(row => this.mapRegionRow(row));
  }

  touchRegion(code: string): void {
    this.db.prepare('UPDATE regions SET last_seen_at = datetime(\'now\') WHERE code = ?')
      .run(Storage.normalizeRegionCode(code));
  }

  getRegionVersion(): number {
    const row = this.db.prepare(`
      SELECT MAX(CAST(strftime('%s', COALESCE(last_seen_at, updated_at, registered_at)) AS INTEGER)) AS version
      FROM regions
      WHERE enabled = 1
    `).get() as { version: number | null };
    return Number(row.version ?? 0);
  }

  private mapRegionRow(row: RegionRow): StoredRegion {
    return {
      code: row.code,
      relayUrl: row.relay_url,
      displayName: row.display_name ?? undefined,
      enabled: row.enabled === 1,
      registeredAt: row.registered_at,
      updatedAt: row.updated_at,
      lastSeenAt: row.last_seen_at ?? undefined,
    };
  }

  // --- Edge registration / service credentials ---

  issueEdgeJoinToken(expiresIn = 300): {
    token: string;
    expiresIn: number;
  } {
    const ttl = Math.max(60, Math.floor(expiresIn));
    const token = `kjt_${randomBytes(18).toString('hex')}`;
    const tokenHash = Storage.hashSecret(token);

    this.db.prepare(`
      INSERT INTO edge_join_tokens (token_hash, expires_at)
      VALUES (?, datetime('now', '+' || ? || ' seconds'))
    `).run(tokenHash, ttl);

    return { token, expiresIn: ttl };
  }

  consumeEdgeJoinToken(token: string, region: string, relayUrl: string, displayName?: string): (
    { ok: true; region: string; relayUrl: string; displayName?: string }
    | { ok: false; code: string; message: string }
  ) {
    const normalizedRegion = Storage.normalizeRegionCode(region);
    const trimmedRelayUrl = relayUrl.trim();
    if (!trimmedRelayUrl) {
      return { ok: false, code: 'bad_request', message: 'relayUrl is required' };
    }

    const tokenHash = Storage.hashSecret(token);
    const row = this.db.prepare(`
      SELECT token_hash, region, relay_url, display_name, expires_at, used_at, created_at
      FROM edge_join_tokens
      WHERE token_hash = ?
    `).get(tokenHash) as EdgeJoinTokenRow | undefined;

    if (!row) {
      return { ok: false, code: 'invalid_join_token', message: 'Join token not found' };
    }
    if (row.used_at) {
      return { ok: false, code: 'join_token_used', message: 'Join token has already been used' };
    }

    const expiresAt = new Date(`${row.expires_at.replace(' ', 'T')}Z`).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return { ok: false, code: 'join_token_expired', message: 'Join token has expired' };
    }

    this.db.prepare('UPDATE edge_join_tokens SET used_at = datetime(\'now\'), region = ?, relay_url = ?, display_name = ? WHERE token_hash = ?')
      .run(normalizedRegion, trimmedRelayUrl, displayName ?? null, tokenHash);

    return {
      ok: true,
      region: normalizedRegion,
      relayUrl: trimmedRelayUrl,
      displayName: displayName ?? undefined,
    };
  }

  issueRegionServiceKey(region: string): { region: string; serviceKey: string } {
    const normalizedRegion = Storage.normalizeRegionCode(region);
    const serviceKey = `ksk_${randomBytes(24).toString('hex')}`;
    const serviceKeyHash = Storage.hashSecret(serviceKey);

    this.db.prepare(`
      INSERT INTO edge_services (region, service_key_hash)
      VALUES (?, ?)
      ON CONFLICT(region) DO UPDATE SET
        service_key_hash = excluded.service_key_hash,
        issued_at = datetime('now'),
        last_seen_at = NULL
    `).run(normalizedRegion, serviceKeyHash);

    return { region: normalizedRegion, serviceKey };
  }

  validateServiceKey(serviceKey: string): { valid: true; region: string } | { valid: false } {
    const row = this.db.prepare(`
      SELECT region, service_key_hash, issued_at, last_seen_at
      FROM edge_services
      WHERE service_key_hash = ?
    `).get(Storage.hashSecret(serviceKey)) as EdgeServiceRow | undefined;

    if (!row) return { valid: false };

    this.db.prepare('UPDATE edge_services SET last_seen_at = datetime(\'now\') WHERE region = ?').run(row.region);
    this.touchRegion(row.region);
    return { valid: true, region: row.region };
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

  // --- Pending messages ---

  private static readonly MAX_PENDING_PER_DEVICE = 200;
  private static readonly PENDING_TTL_DAYS = 30;

  /** Queue a unicast envelope for an offline device. */
  insertPending(targetDeviceId: string, userId: string, envelope: string): void {
    // Enforce per-device cap — drop oldest if at limit
    const count = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM pending_messages WHERE target_device_id = ?'
    ).get(targetDeviceId) as { cnt: number }).cnt;

    if (count >= Storage.MAX_PENDING_PER_DEVICE) {
      const excess = count - Storage.MAX_PENDING_PER_DEVICE + 1;
      this.db.prepare(`
        DELETE FROM pending_messages WHERE id IN (
          SELECT id FROM pending_messages WHERE target_device_id = ? ORDER BY id ASC LIMIT ?
        )
      `).run(targetDeviceId, excess);
    }

    this.db.prepare(
      'INSERT INTO pending_messages (target_device_id, user_id, envelope) VALUES (?, ?, ?)'
    ).run(targetDeviceId, userId, envelope);
  }

  /** Retrieve and delete all pending messages for a device. Returns JSON envelope strings. */
  flushPending(targetDeviceId: string): string[] {
    const rows = this.db.prepare(
      'SELECT id, envelope FROM pending_messages WHERE target_device_id = ? ORDER BY id ASC'
    ).all(targetDeviceId) as Array<{ id: number; envelope: string }>;

    if (rows.length === 0) return [];

    const ids = rows.map(r => r.id);
    this.db.prepare(
      `DELETE FROM pending_messages WHERE id IN (${ids.map(() => '?').join(',')})`
    ).run(...ids);

    return rows.map(r => r.envelope);
  }

  /** Delete all pending messages for a device (used on device removal). */
  deletePendingForDevice(targetDeviceId: string): void {
    this.db.prepare('DELETE FROM pending_messages WHERE target_device_id = ?').run(targetDeviceId);
  }

  /** Drop pending messages older than TTL. */
  expirePending(): number {
    const result = this.db.prepare(
      `DELETE FROM pending_messages WHERE created_at < datetime('now', '-${Storage.PENDING_TTL_DAYS} days')`
    ).run();
    return result.changes;
  }

  // --- Device activity ---

  /** Update last_seen timestamp for a device (called on disconnect). */
  touchDeviceLastSeen(deviceId: string): void {
    this.db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE id = ?").run(deviceId);
  }

  // --- Push tokens ---

  upsertPushToken(deviceId: string, provider: string, token: string, environment?: string, bundleId?: string): void {
    this.db.prepare(`
      INSERT INTO push_tokens (device_id, provider, token, environment, bundle_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id, provider) DO UPDATE SET
        token = excluded.token,
        environment = excluded.environment,
        bundle_id = excluded.bundle_id,
        updated_at = datetime('now')
    `).run(deviceId, provider, token, environment ?? null, bundleId ?? null);
  }

  deletePushToken(deviceId: string, provider: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM push_tokens WHERE device_id = ? AND provider = ?'
    ).run(deviceId, provider);
    return result.changes > 0;
  }

  deletePushTokensForDevice(deviceId: string): void {
    this.db.prepare('DELETE FROM push_tokens WHERE device_id = ?').run(deviceId);
  }

  /**
   * Delete push tokens from stale devices of the same user.
   * A device is considered stale if it is not currently connected
   * AND its last_seen is older than the given threshold (default 24h).
   * Returns the number of tokens deleted.
   */
  deleteStaleUserPushTokens(userId: string, excludeDeviceId: string, onlineDeviceIds: string[], maxAgeHours = 24): number {
    const hours = Math.floor(Math.abs(Number(maxAgeHours)));
    if (!Number.isFinite(hours) || hours === 0) return 0;
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const allExcluded = [excludeDeviceId, ...onlineDeviceIds];
    const placeholders = allExcluded.map(() => '?').join(',');
    const result = this.db.prepare(`
      DELETE FROM push_tokens WHERE device_id IN (
        SELECT d.id FROM devices d
        WHERE d.user_id = ?
          AND d.id NOT IN (${placeholders})
          AND d.last_seen < ?
      )
    `).run(userId, ...allExcluded, cutoff);
    return result.changes;
  }

  /** Get push tokens for offline devices of a user (devices NOT in the online set). */
  getPushTokensForOfflineDevices(userId: string, onlineDeviceIds: string[]): StoredPushToken[] {
    if (onlineDeviceIds.length === 0) {
      // All devices are offline — return all tokens for user's devices
      const rows = this.db.prepare(`
        SELECT pt.device_id, pt.provider, pt.token, pt.environment, pt.bundle_id, pt.created_at, pt.updated_at
        FROM push_tokens pt
        JOIN devices d ON pt.device_id = d.id
        WHERE d.user_id = ?
      `).all(userId) as Array<{ device_id: string; provider: string; token: string; environment: string | null; bundle_id: string | null; created_at: string; updated_at: string }>;
      return rows.map(r => this.mapPushTokenRow(r));
    }

    const placeholders = onlineDeviceIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT pt.device_id, pt.provider, pt.token, pt.environment, pt.bundle_id, pt.created_at, pt.updated_at
      FROM push_tokens pt
      JOIN devices d ON pt.device_id = d.id
      WHERE d.user_id = ? AND pt.device_id NOT IN (${placeholders})
    `).all(userId, ...onlineDeviceIds) as Array<{ device_id: string; provider: string; token: string; environment: string | null; bundle_id: string | null; created_at: string; updated_at: string }>;
    return rows.map(r => this.mapPushTokenRow(r));
  }

  private mapPushTokenRow(row: { device_id: string; provider: string; token: string; environment: string | null; bundle_id: string | null; created_at: string; updated_at: string }): StoredPushToken {
    return {
      deviceId: row.device_id, provider: row.provider, token: row.token,
      environment: row.environment, bundleId: row.bundle_id,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // --- Counts ---

  getUserCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
  }

  getDeviceCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM devices').get() as { cnt: number }).cnt;
  }

  getAllUsers(): StoredUser[] {
    const rows = this.db.prepare(
      'SELECT user_id, username, provider, email, preferences, region, created_at FROM users ORDER BY created_at'
    ).all() as UserRow[];
    return rows.map(row => ({
      userId: row.user_id, username: row.username, provider: row.provider,
      email: row.email ?? undefined, region: row.region ?? undefined, createdAt: row.created_at,
    }));
  }

  // --- Cleanup ---

  close(): void {
    this.db.close();
  }
}
