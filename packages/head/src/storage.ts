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

const SCHEMA_VERSION = 10;

export class Storage {
  private db: Database.Database;

  /** Raw SQLite handle for adjacent subsystems (e.g. the pulse hub's own
   *  tables). Same file + connection, so writes are transactionally consistent
   *  with the users/devices/pending tables. */
  get rawDb(): Database.Database {
    return this.db;
  }

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
      // Historically created the `pending_messages` table (offline unicast
      // queue). That mechanism is superseded by the pulse durable outbox and
      // has been removed. The migration step is kept (not decremented) so the
      // version ladder stays aligned for DBs that upgraded through it; the
      // table, if present in an old DB, is simply unused.
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

    if (currentVersion < 8) {
      // Voice-broker leases — audit trail + daily reservation source of truth.
      // New leases reserve `quota_seconds`; later migrations add one-time
      // activation and trusted actual-audio settlement.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS voice_leases (
          jti            TEXT PRIMARY KEY,
          user_id        TEXT NOT NULL,
          device_id      TEXT NOT NULL,
          resource       TEXT NOT NULL,
          quota_seconds  INTEGER NOT NULL,
          issued_at      TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at     TEXT NOT NULL,
          revoked_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_voice_leases_user_day
          ON voice_leases(user_id, issued_at);
      `);
    }

    if (currentVersion < 9) {
      // Voice usage settlement. A newly issued lease reserves its full quota;
      // once the broker reports trusted audio usage, daily accounting uses the
      // settled seconds instead. Unsettled rows remain conservatively reserved.
      const columns = new Set(
        (this.db.prepare('PRAGMA table_info(voice_leases)').all() as Array<{ name: string }>)
          .map((column) => column.name)
      );
      if (!columns.has('used_seconds')) {
        this.db.exec('ALTER TABLE voice_leases ADD COLUMN used_seconds INTEGER');
      }
      if (!columns.has('settled_at')) {
        this.db.exec('ALTER TABLE voice_leases ADD COLUMN settled_at TEXT');
      }
      if (!columns.has('settlement_reason')) {
        this.db.exec('ALTER TABLE voice_leases ADD COLUMN settlement_reason TEXT');
      }
    }

    if (currentVersion < 10) {
      // One-time lease activation distinguishes an unused expired reservation
      // from a real session whose final settlement may be delayed or lost.
      const columns = new Set(
        (this.db.prepare('PRAGMA table_info(voice_leases)').all() as Array<{ name: string }>)
          .map((column) => column.name)
      );
      if (!columns.has('activation_id')) {
        this.db.exec('ALTER TABLE voice_leases ADD COLUMN activation_id TEXT');
      }
      if (!columns.has('activated_at')) {
        this.db.exec('ALTER TABLE voice_leases ADD COLUMN activated_at TEXT');
      }
      // Rows created before activation accounting existed have unknown usage.
      // Preserve their historical full reservation and make them non-replayable
      // instead of incorrectly treating them as unused after an upgrade.
      this.db.exec(`
        UPDATE voice_leases
        SET activation_id = 'legacy:' || jti,
            activated_at = issued_at
        WHERE activation_id IS NULL AND activated_at IS NULL
      `);
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

  // --- Voice leases ---

  /**
   * Record a freshly-issued voice lease. The `jti` is unique; collisions
   * raise — this surfaces UUID generation bugs immediately.
   */
  recordVoiceLease(input: {
    jti: string;
    userId: string;
    deviceId: string;
    resource: string;
    quotaSeconds: number;
    issuedAtUnixSec: number;
    expiresAtUnixSec: number;
  }): void {
    const issuedIso = new Date(input.issuedAtUnixSec * 1000).toISOString();
    const expiresIso = new Date(input.expiresAtUnixSec * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO voice_leases (jti, user_id, device_id, resource, quota_seconds, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.jti, input.userId, input.deviceId, input.resource, input.quotaSeconds, issuedIso, expiresIso);
  }

  /**
   * Daily reserved/consumed voice seconds for a user. Unsettled leases reserve
   * their full signed quota so concurrent sessions cannot bypass the cap.
   * Settled leases count only trusted broker-reported audio seconds.
   */
  sumVoiceLeaseQuotaIssuedToday(userId: string, nowUnixSec: number): number {
    const day = new Date(nowUnixSec * 1000).toISOString().slice(0, 10);
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN settled_at IS NOT NULL THEN COALESCE(used_seconds, quota_seconds)
          WHEN activated_at IS NOT NULL THEN quota_seconds
          WHEN unixepoch(expires_at) + 60 > ? THEN quota_seconds
          ELSE 0
        END
      ), 0) AS total
      FROM voice_leases
      WHERE user_id = ? AND substr(issued_at, 1, 10) = ?
    `).get(nowUnixSec, userId, day) as { total: number };
    return Number(row.total) || 0;
  }

  /**
   * Activate a signed lease exactly once before the broker accepts audio.
   * Retries carrying the same activation id are idempotent; a different id is
   * a replay attempt and conflicts.
   */
  activateVoiceLease(input: {
    jti: string;
    activationId: string;
    activatedAtUnixSec?: number;
  }): { status: 'activated' | 'unchanged' | 'conflict' | 'expired' | 'wrong_day' | 'revoked' | 'not_found' } {
    const nowUnixSec = input.activatedAtUnixSec ?? Math.floor(Date.now() / 1000);
    const activationDay = new Date(nowUnixSec * 1000).toISOString().slice(0, 10);
    const lease = this.db.prepare(`
      SELECT activation_id, activated_at, issued_at,
             unixepoch(expires_at) AS expires_at_unix, revoked_at
      FROM voice_leases WHERE jti = ?
    `).get(input.jti) as {
      activation_id: string | null;
      activated_at: string | null;
      issued_at: string;
      expires_at_unix: number;
      revoked_at: string | null;
    } | undefined;
    if (!lease) return { status: 'not_found' };
    if (lease.revoked_at !== null) return { status: 'revoked' };
    if (lease.activated_at !== null) {
      return { status: lease.activation_id === input.activationId ? 'unchanged' : 'conflict' };
    }
    if (lease.expires_at_unix <= nowUnixSec) return { status: 'expired' };
    if (lease.issued_at.slice(0, 10) !== activationDay) return { status: 'wrong_day' };
    const activatedAt = new Date(nowUnixSec * 1000).toISOString();
    const result = this.db.prepare(`
      UPDATE voice_leases SET activation_id = ?, activated_at = ?
      WHERE jti = ? AND activated_at IS NULL AND revoked_at IS NULL
        AND unixepoch(expires_at) > ? AND substr(issued_at, 1, 10) = ?
    `).run(input.activationId, activatedAt, input.jti, nowUnixSec, activationDay);
    if (result.changes === 1) return { status: 'activated' };
    const current = this.db.prepare(`
      SELECT activation_id, activated_at, issued_at,
             unixepoch(expires_at) AS expires_at_unix, revoked_at
      FROM voice_leases WHERE jti = ?
    `).get(input.jti) as {
      activation_id: string | null;
      activated_at: string | null;
      issued_at: string;
      expires_at_unix: number;
      revoked_at: string | null;
    } | undefined;
    if (!current) return { status: 'not_found' };
    if (current.revoked_at !== null) return { status: 'revoked' };
    if (current.activated_at !== null) {
      return { status: current.activation_id === input.activationId ? 'unchanged' : 'conflict' };
    }
    if (current.expires_at_unix <= nowUnixSec) return { status: 'expired' };
    if (current.issued_at.slice(0, 10) !== activationDay) return { status: 'wrong_day' };
    return { status: 'conflict' };
  }

  /**
   * Idempotently settle one lease to actual broker-observed audio seconds.
   * First write wins; retries with the same value are accepted, while a
   * conflicting replay is rejected instead of silently changing accounting.
   */
  settleVoiceLease(input: {
    jti: string;
    activationId: string;
    audioSeconds: number;
    reason?: string;
    settledAtUnixSec?: number;
  }): { status: 'settled' | 'unchanged' | 'conflict' | 'not_found' | 'not_activated'; usedSeconds?: number } {
    const lease = this.db.prepare(`
      SELECT quota_seconds, used_seconds, settled_at, activation_id, activated_at
      FROM voice_leases WHERE jti = ?
    `).get(input.jti) as {
      quota_seconds: number;
      used_seconds: number | null;
      settled_at: string | null;
      activation_id: string | null;
      activated_at: string | null;
    } | undefined;
    if (!lease) return { status: 'not_found' };
    if (lease.activated_at === null) return { status: 'not_activated' };
    if (lease.activation_id !== input.activationId) return { status: 'conflict' };

    const usedSeconds = Math.min(
      lease.quota_seconds,
      Math.max(0, Math.ceil(input.audioSeconds))
    );
    if (lease.settled_at !== null) {
      return lease.used_seconds === usedSeconds
        ? { status: 'unchanged', usedSeconds }
        : { status: 'conflict', usedSeconds: lease.used_seconds ?? undefined };
    }

    const settledAt = new Date(
      (input.settledAtUnixSec ?? Math.floor(Date.now() / 1000)) * 1000
    ).toISOString();
    const result = this.db.prepare(`
      UPDATE voice_leases
      SET used_seconds = ?, settled_at = ?, settlement_reason = ?
      WHERE jti = ? AND settled_at IS NULL
    `).run(usedSeconds, settledAt, input.reason?.slice(0, 64) ?? null, input.jti);
    if (result.changes === 1) return { status: 'settled', usedSeconds };

    const current = this.db.prepare(`
      SELECT used_seconds FROM voice_leases WHERE jti = ?
    `).get(input.jti) as { used_seconds: number | null } | undefined;
    return current?.used_seconds === usedSeconds
      ? { status: 'unchanged', usedSeconds }
      : { status: 'conflict', usedSeconds: current?.used_seconds ?? undefined };
  }

  /** Fetch a single lease by jti (audit / debug). Returns undefined if unknown. */
  getVoiceLease(jti: string): {
    jti: string;
    userId: string;
    deviceId: string;
    resource: string;
    quotaSeconds: number;
    issuedAt: string;
    expiresAt: string;
    revokedAt: string | null;
    usedSeconds: number | null;
    settledAt: string | null;
    settlementReason: string | null;
    activationId: string | null;
    activatedAt: string | null;
  } | undefined {
    const row = this.db.prepare(`
      SELECT jti, user_id, device_id, resource, quota_seconds, issued_at,
             expires_at, revoked_at, used_seconds, settled_at, settlement_reason,
             activation_id, activated_at
      FROM voice_leases WHERE jti = ?
    `).get(jti) as {
      jti: string; user_id: string; device_id: string; resource: string;
      quota_seconds: number; issued_at: string; expires_at: string; revoked_at: string | null;
      used_seconds: number | null; settled_at: string | null; settlement_reason: string | null;
      activation_id: string | null; activated_at: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      jti: row.jti,
      userId: row.user_id,
      deviceId: row.device_id,
      resource: row.resource,
      quotaSeconds: row.quota_seconds,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      usedSeconds: row.used_seconds,
      settledAt: row.settled_at,
      settlementReason: row.settlement_reason,
      activationId: row.activation_id,
      activatedAt: row.activated_at,
    };
  }

  // --- Cleanup ---

  close(): void {
    this.db.close();
  }
}
