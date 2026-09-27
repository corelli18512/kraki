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

const SCHEMA_VERSION = 12;

/**
 * Audio a live broker connection may run ahead of its last usage report.
 * The broker reports every 15 s while recording and each reply extends the
 * allowance, so a recording never waits on Head; the chunk only bounds what a
 * connection holds in reserve (and what it may use if Head is unreachable).
 */
export const VOICE_GRANT_CHUNK_SEC = 60;

/**
 * Past its expiry a lease still gets grants for the recording in progress
 * (the broker never cuts one off at expiry) for at most this long.
 */
export const VOICE_EXPIRY_OVERRUN_SEC = 900;

/**
 * A connection past its overrun window can no longer be granted audio and the
 * broker hard-stops it; keep reserving its last grant a little longer so a
 * lost close report never frees budget the broker may still be using.
 */
const VOICE_RESERVATION_SLACK_SEC = 120;

const utcDay = (unixSec: number) => new Date(unixSec * 1000).toISOString().slice(0, 10);

/**
 * Broker usage reasons emitted while the warm socket stays open (periodic
 * checkpoints, reconnect takeover, end of one recording). Any other reason is
 * the broker's forced final report for a closing socket.
 */
const VOICE_OPEN_USAGE_REASONS = new Set([
  'checkpoint',
  'connection_takeover',
  'session_final',
  'asr_open_failed',
  'asr_error',
  'asr_closed',
  'asr_send_failed',
]);

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

    if (currentVersion < 11) {
      // Warm voice connections reuse one lease for many sequential recordings.
      // Keep the broker's exact cumulative audio value so reconnects resume
      // without rounding drift; `used_seconds` remains the rounded daily/audit
      // projection. Existing one-shot settlements seed the cumulative value.
      const columns = new Set(
        (this.db.prepare('PRAGMA table_info(voice_leases)').all() as Array<{ name: string }>)
          .map((column) => column.name)
      );
      if (!columns.has('reported_audio_seconds')) {
        this.db.exec('ALTER TABLE voice_leases ADD COLUMN reported_audio_seconds REAL NOT NULL DEFAULT 0');
      }
      this.db.exec(`
        UPDATE voice_leases
        SET reported_audio_seconds = COALESCE(used_seconds, 0)
        WHERE reported_audio_seconds = 0 AND used_seconds IS NOT NULL
      `);
    }

    if (currentVersion < 12) {
      // Usage-time daily accounting. A lease is a long-lived credential; the
      // budget is granted incrementally (`allowed_seconds`, a cumulative
      // ceiling) and every reported second is charged to the UTC day it was
      // reported on, so a recording crossing midnight splits naturally.
      const columns = new Set(
        (this.db.prepare('PRAGMA table_info(voice_leases)').all() as Array<{ name: string }>)
          .map((column) => column.name)
      );
      if (!columns.has('allowed_seconds')) {
        this.db.exec('ALTER TABLE voice_leases ADD COLUMN allowed_seconds REAL');
      }
      if (!columns.has('closed_at')) {
        this.db.exec('ALTER TABLE voice_leases ADD COLUMN closed_at TEXT');
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS voice_usage_daily (
          user_id  TEXT NOT NULL,
          day      TEXT NOT NULL,
          seconds  REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, day)
        );
        INSERT OR IGNORE INTO voice_usage_daily (user_id, day, seconds)
          SELECT user_id, substr(issued_at, 1, 10),
                 SUM(MAX(COALESCE(reported_audio_seconds, 0), COALESCE(used_seconds, 0)))
          FROM voice_leases GROUP BY user_id, substr(issued_at, 1, 10);
      `);
      // Close reports were not recorded before. Clients only request a new
      // lease after closing the old socket, so a lease whose device later
      // *activated* a newer lease is closed. Leases whose successor never
      // connected keep reserving (their socket may still be recording).
      this.db.exec(`
        UPDATE voice_leases
        SET closed_at = COALESCE(settled_at, activated_at, issued_at)
        WHERE closed_at IS NULL AND activated_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM voice_leases newer
          WHERE newer.user_id = voice_leases.user_id
            AND newer.device_id = voice_leases.device_id
            AND newer.resource = voice_leases.resource
            AND newer.activated_at IS NOT NULL
            AND (newer.activated_at, newer.issued_at, newer.jti)
              > (voice_leases.activated_at, voice_leases.issued_at, voice_leases.jti)
        )
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
   * Voice seconds charged against a user's daily cap for the UTC day of
   * `nowUnixSec`: audio reported today, plus the not-yet-used part of the
   * allowance held by live connections (at most one grant chunk each), so
   * concurrent devices can never jointly exceed the cap. `excludeJti` leaves
   * one lease's reservation out (used when re-granting that lease).
   */
  voiceSecondsAccountedToday(userId: string, nowUnixSec: number, excludeJti = ''): number {
    const used = this.db.prepare(`
      SELECT seconds FROM voice_usage_daily WHERE user_id = ? AND day = ?
    `).get(userId, utcDay(nowUnixSec)) as { seconds: number } | undefined;
    const reserved = this.db.prepare(`
      SELECT COALESCE(SUM(MAX(0,
        COALESCE(allowed_seconds, quota_seconds) - COALESCE(reported_audio_seconds, 0)
      )), 0) AS total
      FROM voice_leases
      WHERE user_id = ? AND jti != ?
        AND activated_at IS NOT NULL AND closed_at IS NULL
        AND unixepoch(expires_at) + ? > ?
    `).get(
      userId, excludeJti, VOICE_EXPIRY_OVERRUN_SEC + VOICE_RESERVATION_SLACK_SEC, nowUnixSec,
    ) as { total: number };
    return Math.ceil((Number(used?.seconds) || 0) + (Number(reserved.total) || 0));
  }

  /**
   * A device only ever holds one lease: when it asks for a new one, its
   * earlier leases that never connected are abandoned. Revoke them so they can
   * never be activated later.
   */
  revokePendingVoiceLeases(userId: string, deviceId: string, resource: string, nowUnixSec: number): number {
    return this.db.prepare(`
      UPDATE voice_leases SET revoked_at = ?
      WHERE user_id = ? AND device_id = ? AND resource = ?
        AND activated_at IS NULL AND revoked_at IS NULL
    `).run(new Date(nowUnixSec * 1000).toISOString(), userId, deviceId, resource).changes;
  }

  /**
   * Cumulative allowance for a lease that has reported `reported` seconds:
   * `reported` plus what today's budget leaves (optionally at most one chunk),
   * never above the signed per-lease ceiling.
   */
  private voiceAllowance(
    lease: { jti: string; user_id: string; quota_seconds: number },
    reported: number,
    nowUnixSec: number,
    dailyCapSec: number,
    chunkSec: number,
  ): number {
    const accounted = this.voiceSecondsAccountedToday(lease.user_id, nowUnixSec, lease.jti);
    const budgetLeft = Math.max(0, dailyCapSec - accounted);
    return Math.min(lease.quota_seconds, reported + Math.min(chunkSec, budgetLeft));
  }

  /**
   * Activate a lease connection before the broker accepts recordings. The
   * same activation id is an idempotent retry; a different one replaces the
   * previous owner (last-writer-wins reconnect) and makes stale checkpoints
   * fail closed. Returns the exact cumulative usage (to resume) and, with a
   * daily cap, the cumulative allowance the broker must enforce: one grant
   * chunk for brokers that renew grants on usage reports, otherwise all that
   * today's budget leaves.
   */
  activateVoiceLease(input: {
    jti: string;
    activationId: string;
    activatedAtUnixSec?: number;
    dailyCapSec?: number;
    /** The broker renews the allowance through usage reports. */
    grants?: boolean;
  }): {
    status: 'activated' | 'unchanged' | 'replaced' | 'expired' | 'revoked'
      | 'quota_exhausted' | 'grants_required' | 'not_found';
    reportedAudioSeconds?: number;
    quotaSeconds?: number;
  } {
    const nowUnixSec = input.activatedAtUnixSec ?? Math.floor(Date.now() / 1000);
    const lease = this.db.prepare(`
      SELECT jti, user_id, quota_seconds, allowed_seconds, activation_id, activated_at,
             unixepoch(expires_at) AS expires_at_unix, revoked_at,
             COALESCE(reported_audio_seconds, 0) AS reported_audio_seconds
      FROM voice_leases WHERE jti = ?
    `).get(input.jti) as {
      jti: string;
      user_id: string;
      quota_seconds: number;
      allowed_seconds: number | null;
      activation_id: string | null;
      activated_at: string | null;
      expires_at_unix: number;
      revoked_at: string | null;
      reported_audio_seconds: number;
    } | undefined;
    if (!lease) return { status: 'not_found' };
    if (lease.revoked_at !== null) return { status: 'revoked' };
    if (lease.expires_at_unix <= nowUnixSec) return { status: 'expired' };

    const reportedAudioSeconds = Number(lease.reported_audio_seconds) || 0;
    if (lease.activated_at !== null && lease.activation_id === input.activationId) {
      return {
        status: 'unchanged',
        reportedAudioSeconds,
        quotaSeconds: lease.allowed_seconds ?? lease.quota_seconds,
      };
    }

    let allowedSeconds = lease.quota_seconds;
    if (input.dailyCapSec !== undefined) {
      allowedSeconds = this.voiceAllowance(
        lease, reportedAudioSeconds, nowUnixSec, input.dailyCapSec,
        input.grants ? VOICE_GRANT_CHUNK_SEC : Number.POSITIVE_INFINITY,
      );
      if (!input.grants && lease.quota_seconds > input.dailyCapSec) {
        // A broker that ignores grants would enforce the day-scale signed
        // ceiling and let one socket exceed the cap: refuse (fail closed).
        return { status: 'grants_required', reportedAudioSeconds };
      }
      if (!input.grants && allowedSeconds < lease.quota_seconds) {
        return { status: 'quota_exhausted', reportedAudioSeconds };
      }
      if (allowedSeconds - reportedAudioSeconds < 1) {
        if (lease.activated_at === null) {
          // Never connected and now unusable: nobody should activate it later.
          this.db.prepare(`
            UPDATE voice_leases SET revoked_at = ? WHERE jti = ? AND activated_at IS NULL
          `).run(new Date(nowUnixSec * 1000).toISOString(), input.jti);
        }
        return { status: 'quota_exhausted', reportedAudioSeconds };
      }
    }

    // Last-writer-wins: the broker transfers a replaced same-process owner's
    // unreported audio to the new owner (reported as connection_takeover).
    // Assumes one broker process per lease; across processes a replaced
    // socket could use at most its last grant chunk unaccounted.
    this.db.prepare(`
      UPDATE voice_leases
      SET activation_id = ?, activated_at = ?, allowed_seconds = ?, closed_at = NULL
      WHERE jti = ? AND revoked_at IS NULL AND unixepoch(expires_at) > ?
    `).run(input.activationId, new Date(nowUnixSec * 1000).toISOString(), allowedSeconds, input.jti, nowUnixSec);
    return {
      status: lease.activated_at === null ? 'activated' : 'replaced',
      reportedAudioSeconds,
      quotaSeconds: allowedSeconds,
    };
  }

  /**
   * Store a monotonic cumulative usage checkpoint for one lease connection
   * and charge the increase to the UTC day it is reported on. Equal values
   * are idempotent; lower out-of-order retries are stale but harmless;
   * checkpoints from a replaced activation are rejected. The broker's final
   * report for a closing socket releases its reservation.
   *
   * With `grants`, a report from a live connection also renews its allowance
   * (returned as `quotaSeconds`): one chunk ahead while today's budget lasts,
   * nothing more once the lease is revoked or long past expiry.
   */
  settleVoiceLease(input: {
    jti: string;
    activationId: string;
    audioSeconds: number;
    reason?: string;
    settledAtUnixSec?: number;
    dailyCapSec?: number;
    grants?: boolean;
  }): {
    status: 'updated' | 'unchanged' | 'stale' | 'conflict' | 'not_found' | 'not_activated';
    usedSeconds?: number;
    reportedAudioSeconds?: number;
    quotaSeconds?: number;
  } {
    const lease = this.db.prepare(`
      SELECT jti, user_id, quota_seconds, allowed_seconds, used_seconds, activation_id,
             activated_at, closed_at, revoked_at, unixepoch(expires_at) AS expires_at_unix,
             COALESCE(reported_audio_seconds, 0) AS reported_audio_seconds
      FROM voice_leases WHERE jti = ?
    `).get(input.jti) as {
      jti: string;
      user_id: string;
      quota_seconds: number;
      allowed_seconds: number | null;
      used_seconds: number | null;
      activation_id: string | null;
      activated_at: string | null;
      closed_at: string | null;
      revoked_at: string | null;
      expires_at_unix: number;
      reported_audio_seconds: number;
    } | undefined;
    if (!lease) return { status: 'not_found' };
    if (lease.activated_at === null) return { status: 'not_activated' };
    const nowUnixSec = input.settledAtUnixSec ?? Math.floor(Date.now() / 1000);
    const nowIso = new Date(nowUnixSec * 1000).toISOString();
    if (lease.activation_id !== input.activationId) return { status: 'conflict' };

    const closing = !VOICE_OPEN_USAGE_REASONS.has(input.reason ?? '');
    const currentReported = Number(lease.reported_audio_seconds) || 0;
    const reported = Math.min(lease.quota_seconds, Math.max(0, input.audioSeconds));
    let status: 'updated' | 'unchanged' | 'stale' = 'unchanged';
    let latestReported = currentReported;

    this.db.transaction(() => {
      if (reported > currentReported) {
        status = 'updated';
        latestReported = reported;
        this.db.prepare(`
          UPDATE voice_leases
          SET reported_audio_seconds = ?, used_seconds = ?, settled_at = ?, settlement_reason = ?
          WHERE jti = ? AND activation_id = ?
        `).run(reported, Math.ceil(reported), nowIso, input.reason?.slice(0, 64) ?? null,
          input.jti, input.activationId);
        this.chargeVoiceUsage(lease.user_id, nowUnixSec, reported - currentReported);
      } else if (reported < currentReported) {
        status = 'stale';
      }
      // Closing is terminal for this activation; only a new activation
      // (reconnect) reopens the lease.
      if (closing && lease.closed_at === null) {
        this.db.prepare('UPDATE voice_leases SET closed_at = ? WHERE jti = ?').run(nowIso, input.jti);
      }
    })();

    let quotaSeconds: number | undefined;
    if (input.grants && !closing && input.dailyCapSec !== undefined) {
      const live = lease.revoked_at === null && lease.closed_at === null
        && nowUnixSec < lease.expires_at_unix + VOICE_EXPIRY_OVERRUN_SEC;
      quotaSeconds = live
        ? this.voiceAllowance(lease, latestReported, nowUnixSec, input.dailyCapSec, VOICE_GRANT_CHUNK_SEC)
        : latestReported;
      this.db.prepare('UPDATE voice_leases SET allowed_seconds = ? WHERE jti = ?')
        .run(quotaSeconds, input.jti);
    }

    return {
      status,
      usedSeconds: Math.max(lease.used_seconds ?? 0, Math.ceil(latestReported)),
      reportedAudioSeconds: latestReported,
      ...(quotaSeconds !== undefined ? { quotaSeconds } : {}),
    };
  }

  private chargeVoiceUsage(userId: string, nowUnixSec: number, seconds: number): void {
    if (!(seconds > 0)) return;
    this.db.prepare(`
      INSERT INTO voice_usage_daily (user_id, day, seconds) VALUES (?, ?, ?)
      ON CONFLICT (user_id, day) DO UPDATE SET seconds = seconds + excluded.seconds
    `).run(userId, utcDay(nowUnixSec), seconds);
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
    reportedAudioSeconds: number;
    activationId: string | null;
    activatedAt: string | null;
    allowedSeconds: number | null;
    closedAt: string | null;
  } | undefined {
    const row = this.db.prepare(`
      SELECT jti, user_id, device_id, resource, quota_seconds, issued_at,
             expires_at, revoked_at, used_seconds, settled_at, settlement_reason,
             COALESCE(reported_audio_seconds, 0) AS reported_audio_seconds,
             activation_id, activated_at, allowed_seconds, closed_at
      FROM voice_leases WHERE jti = ?
    `).get(jti) as {
      jti: string; user_id: string; device_id: string; resource: string;
      quota_seconds: number; issued_at: string; expires_at: string; revoked_at: string | null;
      used_seconds: number | null; settled_at: string | null; settlement_reason: string | null;
      reported_audio_seconds: number; activation_id: string | null; activated_at: string | null;
      allowed_seconds: number | null; closed_at: string | null;
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
      reportedAudioSeconds: Number(row.reported_audio_seconds) || 0,
      activationId: row.activation_id,
      activatedAt: row.activated_at,
      allowedSeconds: row.allowed_seconds,
      closedAt: row.closed_at,
    };
  }

  // --- Cleanup ---

  close(): void {
    this.db.close();
  }
}
