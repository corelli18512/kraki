/**
 * Upload loop for performance data — native DiagClient (KrakiDiag.swift):
 * one request at a time, foreground only, `GET config` (opt-in from the
 * collector, fail closed) then `POST batch` of complete gzip batches signed
 * with this device's existing key. Same paths, headers, signing text, status
 * handling, backoff and daily limit.
 */
import { BATCH_MAX_BYTES, DiagSpool, type DiagSpoolStore } from './spool';
import type { DiagEvent, DiagRecorder } from './recorder';

export interface DiagHttpRequest {
  /** https origin of the relay (or http loopback). */
  base: string;
  path: 'config' | 'batch';
  headers: Record<string, string>;
  body?: Uint8Array;
}
export type DiagHttp = (req: DiagHttpRequest) => Promise<{ status: number; body: string }>;

export interface DiagClientDeps {
  recorder: DiagRecorder;
  store: DiagSpoolStore;
  http: DiagHttp;
  platform: string;
  version: string;
  build: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => number;
  random?: () => number;
  gzip?: (data: Uint8Array) => Promise<Uint8Array>;
}

const KEY = {
  enabled: 'kraki.diag.enabled', day: 'kraki.diag.day', bytes: 'kraki.diag.bytes',
  lastSuccess: 'kraki.diag.lastSuccess', state: 'kraki.diag.uploadState',
};
const DAILY_BYTES = 20 * 1024 * 1024;
const RAW_MAX = 48 * 1024;
const enc = new TextEncoder();

export function diagSigningText(method: string, path: string, device: string, timestamp: string, id: string, digestHex: string): string {
  return ['kraki-diag-v1', method, path, device, timestamp, id, digestHex].join('\n');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(data as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** wss://host → https://host; ws:// only for loopback; anything else null. */
export function diagBase(relay: string): string | null {
  let url: URL;
  try { url = new URL(relay); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.protocol = 'http:';
  else return null;
  return url.origin;
}

export class DiagClient {
  private spool: DiagSpool | null = null;
  private credentials: { base: string; device: string; sign: (m: string) => Promise<string> } | null = null;
  private realm: string | null = null;
  private busy = false;
  private generation = 0;
  private localEnabled: boolean;
  private remoteEnabled = false; // fail closed until the collector opts in
  private foreground = true;
  private nextUpload = 0;
  private nextConfig = 0;
  private failures = 0;
  private configFailures = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly zip: (d: Uint8Array) => Promise<Uint8Array>;

  constructor(private readonly deps: DiagClientDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.zip = deps.gzip ?? gzip;
    this.localEnabled = deps.storage.getItem(KEY.enabled) !== 'false';
    deps.recorder.setEnabled(this.localEnabled);
  }

  start(): void {
    if (this.timer) return;
    if (!this.localEnabled) void this.deps.store.clearExcept(null);
    this.timer = setInterval(() => { void this.tick(); }, 5_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  get enabled(): boolean { return this.localEnabled; }

  async configure(relay: string, device: string, sign: (m: string) => Promise<string>): Promise<void> {
    const base = diagBase(relay);
    if (!base) return;
    const realm = await sha256Hex(enc.encode(`${base}\n${device}`));
    if (this.realm && this.realm !== realm) {
      this.generation += 1;
      await this.spool?.clear();
      this.deps.recorder.drain();
      this.deps.storage.removeItem(KEY.lastSuccess);
    }
    this.generation += 1;
    this.deps.recorder.setEnabled(this.localEnabled);
    this.realm = realm;
    this.credentials = { base, device, sign };
    this.remoteEnabled = false;
    // Never send a previous account/relay's spool to this one.
    await this.deps.store.clearExcept(realm);
    this.spool = new DiagSpool(realm, this.deps.store);
    await this.spool.load();
    if (!this.localEnabled) await this.spool.clear();
    this.nextConfig = this.now() + 5_000;
    this.nextUpload = this.now() + 15_000;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.deps.storage.setItem(KEY.enabled, String(enabled));
    this.localEnabled = enabled;
    this.deps.recorder.setEnabled(enabled && (this.remoteEnabled || !this.credentials));
    this.generation += 1;
    if (!enabled) {
      // Turning it off deletes unsent performance data (Mac copy).
      this.deps.recorder.drain();
      await this.spool?.clear();
      await this.deps.store.clearExcept(null);
    } else this.nextConfig = 0;
  }

  logout(): void {
    this.deps.recorder.setEnabled(false);
    this.generation += 1;
    void this.spool?.clear();
    this.spool = null;
    this.credentials = null; this.realm = null; this.remoteEnabled = false;
    this.deps.recorder.drain();
    this.deps.storage.removeItem(KEY.lastSuccess);
  }

  setForeground(value: boolean): void {
    this.foreground = value;
    if (!value) { void this.flush(); this.generation += 1; }
    else this.nextUpload = Math.max(this.nextUpload, this.now() + 15_000);
  }
  userActivity(): void { this.nextUpload = Math.max(this.nextUpload, this.now() + 10_000); }

  async tick(): Promise<void> {
    if (!this.localEnabled) return;
    await this.flush();
    if (!this.foreground || this.busy || !this.credentials) return;
    // Set before any await: one request at a time (native DiagClient task),
    // through the spool removal and the next-upload time.
    this.busy = true;
    try { await this.request(); } finally { this.busy = false; }
  }

  private async request(): Promise<void> {
    if (this.now() >= this.nextConfig) { await this.sendConfig(); return; }
    const spool = this.spool;
    if (!this.remoteEnabled || this.now() < this.nextUpload || !spool) return;
    const segment = spool.first;
    if (!segment) return;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    let day = this.deps.storage.getItem(KEY.day) ?? '';
    let bytes = Number(this.deps.storage.getItem(KEY.bytes) ?? 0) || 0;
    if (day !== today) { day = today; bytes = 0; }
    if (bytes + segment.bytes > DAILY_BYTES) return;
    // Count attempted uploads across relaunches, not only successes.
    this.deps.storage.setItem(KEY.day, day);
    this.deps.storage.setItem(KEY.bytes, String(bytes + segment.bytes));
    const id = segment.name.split('_')[1]!;
    const status = await this.send('batch', segment.data, id);
    if (status === null) return; // superseded
    if (status !== 204) this.deps.recorder.record('diag.upload', undefined, { status, bytes: segment.bytes });
    if (status === 204) {
      await spool.remove(segment.name); this.failures = 0;
      this.deps.storage.setItem(KEY.lastSuccess, String(this.now() / 1000));
    } else if ([400, 409, 413, 415].includes(status)) await spool.remove(segment.name);
    else this.failures = Math.min(8, this.failures + 1);
    if ([401, 403, 404, 410].includes(status)) {
      this.remoteEnabled = false; this.deps.recorder.setEnabled(false); await spool.clear();
      this.nextConfig = this.now() + 900_000;
    }
    this.deps.storage.setItem(KEY.state, status === 204 ? 'ok' : `http_${status}`);
    const delay = status === 204 ? 5_000 : Math.min(3600, 60 * 2 ** this.failures) * 1000 + this.random() * 10_000;
    this.nextUpload = this.now() + delay;
  }

  /** Local spool write of everything recorded so far, in ≤16 KB gzip batches. */
  async flush(): Promise<void> {
    if (!this.localEnabled || !this.spool) return; // keep bounded pre-auth records in memory
    const { events, dropped } = this.deps.recorder.drain();
    if (dropped > 0) this.deps.recorder.record('diag.health', undefined, { dropped });
    if (events.length) await this.persist(events, this.spool);
  }

  private async persist(events: DiagEvent[], spool: DiagSpool): Promise<void> {
    const batchId = crypto.randomUUID();
    const batch = { schema: 1, batchId, processId: this.deps.recorder.processId, platform: this.deps.platform,
      version: this.deps.version, build: this.deps.build, events };
    try {
      const raw = enc.encode(JSON.stringify(batch));
      const zipped = await this.zip(raw);
      if (raw.byteLength > RAW_MAX || zipped.byteLength > BATCH_MAX_BYTES) {
        if (events.length <= 1) return;
        const mid = Math.floor(events.length / 2);
        await this.persist(events.slice(0, mid), spool);
        await this.persist(events.slice(mid), spool);
      } else await spool.append(zipped, batchId, this.now());
    } catch { /* diagnostics must never break normal functionality */ }
  }

  private async sendConfig(): Promise<void> {
    this.nextConfig = this.now() + 900_000;
    const id = crypto.randomUUID();
    const res = await this.send('config', new Uint8Array(), id, true);
    if (!res) return;
    const { status, body } = res;
    let json: { schema?: unknown; enabled?: unknown } | null = null;
    try { json = JSON.parse(body); } catch { /* not JSON */ }
    if (status === 200 && json?.schema === 1 && typeof json.enabled === 'boolean') {
      this.configFailures = 0;
      this.deps.storage.setItem(KEY.state, json.enabled ? 'ready' : 'remote_disabled');
      this.remoteEnabled = json.enabled;
      this.deps.recorder.setEnabled(this.localEnabled && json.enabled);
      if (!json.enabled) await this.spool?.clear();
    } else if ([401, 403, 404, 410].includes(status)) {
      this.remoteEnabled = false;
      this.deps.recorder.setEnabled(false);
      await this.spool?.clear();
      this.deps.storage.setItem(KEY.state, `config_${status}`);
    } else {
      this.configFailures = Math.min(5, this.configFailures + 1);
      this.nextConfig = this.now() + (Math.min(300, 15 * 2 ** this.configFailures) + this.random() * 5) * 1000;
      this.deps.storage.setItem(KEY.state, `config_${status}`);
    }
  }

  private send(path: 'batch', body: Uint8Array, id: string): Promise<number | null>;
  private send(path: 'config', body: Uint8Array, id: string, full: true): Promise<{ status: number; body: string } | null>;
  private async send(path: 'config' | 'batch', body: Uint8Array, id: string, full?: true): Promise<number | { status: number; body: string } | null> {
    const credentials = this.credentials;
    if (!credentials) return null;
    const method = path === 'config' ? 'GET' : 'POST';
    const fullPath = `/api/diag/v1/${path}`;
    const timestamp = String(Math.floor(this.now()));
    const digest = await sha256Hex(body);
    let signature: string;
    try { signature = await credentials.sign(diagSigningText(method, fullPath, credentials.device, timestamp, id, digest)); }
    catch { return full ? { status: 0, body: '' } : 0; } // bounded retry
    const headers: Record<string, string> = {
      'X-Kraki-Device': credentials.device, 'X-Kraki-Time': timestamp,
      'X-Kraki-Request': id, 'X-Kraki-Signature': signature,
    };
    if (body.byteLength) { headers['Content-Encoding'] = 'gzip'; headers['Content-Type'] = 'application/json'; }
    const generation = this.generation;
    let res: { status: number; body: string };
    try { res = await this.deps.http({ base: credentials.base, path, headers, ...(body.byteLength ? { body } : {}) }); }
    catch { res = { status: 0, body: '' }; }
    if (this.generation !== generation) return null;
    return full ? res : res.status;
  }
}
