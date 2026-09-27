import { DatabaseSync } from 'node:sqlite';

/** Minimal verification boundary. No Head types, session data or write methods. */
export interface DiagnosticDevice {
  id: string;
  userId: string;
  role: string;
  publicKey: string | null;
}

/** Reads committed device registration/key changes (including WAL) on each request.
 * Never creates a missing database, migrates schemas, or copies/caches credentials.
 */
export class SqliteDeviceKeys {
  private readonly db: DatabaseSync;
  private readonly lookup;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    try {
      this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
      this.lookup = this.db.prepare('SELECT id, user_id, role, public_key FROM devices WHERE id = ?');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get(deviceId: string): DiagnosticDevice | undefined {
    const row = this.lookup.get(deviceId);
    if (!row || typeof row.public_key !== 'string') return undefined;
    return { id: String(row.id), userId: String(row.user_id), role: String(row.role), publicKey: row.public_key };
  }

  close(): void { this.db.close(); }
}
