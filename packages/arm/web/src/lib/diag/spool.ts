/**
 * Private bounded spool of complete gzip batches (native DiagSpool). A batch
 * is stored before any upload attempt, so a lost ACK retries identical bytes.
 * Per realm (relay + device): another account/relay never sends this one's.
 */

export interface DiagSegment {
  /** `<ms>_<batchId>`: sorts oldest first. */
  name: string;
  realm: string;
  data: Uint8Array;
  bytes: number;
}

export interface DiagSpoolStore {
  list(realm: string): Promise<DiagSegment[]>;
  put(segment: DiagSegment): Promise<void>;
  remove(name: string): Promise<void>;
  /** Every segment of every realm except `keep`. */
  clearExcept(keep: string | null): Promise<void>;
}

export const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
export const SPOOL_MAX_FILES = 2048;
export const BATCH_MAX_BYTES = 16 * 1024;

export class DiagSpool {
  private segments: DiagSegment[] = [];
  constructor(readonly realm: string, private readonly store: DiagSpoolStore,
    readonly maxBytes = SPOOL_MAX_BYTES, readonly maxFiles = SPOOL_MAX_FILES) {}

  async load(): Promise<void> {
    this.segments = (await this.store.list(this.realm)).sort((a, b) => a.name.localeCompare(b.name));
    await this.trim();
  }
  get first(): DiagSegment | undefined { return this.segments[0]; }
  get count(): number { return this.segments.length; }
  get bytes(): number { return this.segments.reduce((n, s) => n + s.bytes, 0); }

  async append(data: Uint8Array, batchId: string, now = Date.now()): Promise<void> {
    if (data.byteLength > BATCH_MAX_BYTES) return;
    const segment = { name: `${now}_${batchId}`, realm: this.realm, data, bytes: data.byteLength };
    await this.store.put(segment);
    this.segments.push(segment);
    await this.trim();
  }
  async remove(name: string): Promise<void> {
    await this.store.remove(name);
    this.segments = this.segments.filter((s) => s.name !== name);
  }
  async clear(): Promise<void> {
    for (const s of this.segments) await this.store.remove(s.name);
    this.segments = [];
  }
  private async trim(): Promise<void> {
    while (this.segments.length && (this.bytes > this.maxBytes || this.segments.length > this.maxFiles)) {
      await this.remove(this.segments[0]!.name);
    }
  }
}

export class MemorySpoolStore implements DiagSpoolStore {
  readonly rows = new Map<string, DiagSegment>();
  async list(realm: string) { return [...this.rows.values()].filter((s) => s.realm === realm); }
  async put(s: DiagSegment) { this.rows.set(s.name, s); }
  async remove(name: string) { this.rows.delete(name); }
  async clearExcept(keep: string | null) { for (const [k, s] of this.rows) if (s.realm !== keep) this.rows.delete(k); }
}

const DB = 'kraki-diag';
const STORE = 'segments';

export class IdbSpoolStore implements DiagSpoolStore {
  private db: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'name' });
        store.createIndex('realm', 'realm');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  async list(realm: string) {
    return (await this.tx('readonly', (s) => s.index('realm').getAll(realm) as IDBRequest<DiagSegment[]>)) ?? [];
  }
  async put(segment: DiagSegment) { await this.tx('readwrite', (s) => { s.put(segment); }); }
  async remove(name: string) { await this.tx('readwrite', (s) => { s.delete(name); }); }
  async clearExcept(keep: string | null) {
    await this.tx('readwrite', (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if ((cursor.value as DiagSegment).realm !== keep) cursor.delete();
        cursor.continue();
      };
    });
  }
}
