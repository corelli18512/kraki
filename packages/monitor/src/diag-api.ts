/** Off-band, opt-in diagnostics. Never accepts service keys or touches Pulse.
 * Native clients sign a domain-separated request with their registered device key.
 * Bodies contain only schema-allowlisted metadata, never arbitrary log strings.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzipSync } from 'node:zlib';
import type { DiagnosticDevice } from './device-keys.js';

const gunzip = promisify(gunzipCallback);
export const DIAG_PREFIX = '/api/diag/v1/';
const MAX_WIRE = 64 * 1024;
const MAX_RAW = 256 * 1024;
const DAILY_BYTES = 20 * 1024 * 1024;
const RETENTION_MS = 14 * 86400_000;
/** Uploads read at once: per device (clients upload one batch at a time),
 *  per client IP, and for the whole process (bounds buffered bodies). */
const MAX_ACTIVE_PER_DEVICE = 2;
const MAX_ACTIVE_PER_IP = 4;
const MAX_ACTIVE = 32;
const MAX_BUCKETS = 16384;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(v);
const id = (v: unknown) => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const bool = (v: unknown) => typeof v === 'boolean';
const choice = (...values: string[]) => (v: unknown) => typeof v === 'string' && values.includes(v);
type Validator = (value: unknown) => boolean;
export const fields: Record<string, Validator> = {
  clientId: uuid, questionId: id, answerTo: id, ix: uuid,
  origin: choice('ios_choice', 'mac_choice', 'mac_monitor', 'mac_button', 'composer', 'unknown'),
  phase: v => choice('active', 'inactive', 'background', 'authenticated', 'logout', 'created', 'restored', 'retry', 'cleared', 'sending', 'unconfirmed', 'failed', 'correcting', 'down', 'up')(v)
    || (typeof v === 'string' && /^resend_[a-z_]{1,32}$/.test(v)), // automatic resend, tagged with its trigger
  state: choice('connected', 'connecting', 'disconnected'),
  source: v => typeof v === 'string' && /^[\w+./:-]{1,160}$/.test(v), // compiler #fileID, not a path or text
  stack: v => typeof v === 'string' && /^(0x[\da-f]+)(,0x[\da-f]+){0,15}$/i.test(v),
  textLength: number, attachments: number, pending: number, messageSeq: number,
  matched: bool, accepted: bool, duplicate: bool, restored: number, count: number,
  dropped: number, durationMs: number, clickCount: number, eventNumber: number,
  attempt: number, status: number, bytes: number, events: number, firstSeq: number, lastSeq: number,
  // Stability summaries (StabilityTracker): durations, counts and tags only.
  kind: choice('cold', 'warm', 'wake', 'typed', 'voice', 'answer', 'steer', 'head'),
  outcome: choice('ready', 'abandoned', 'timeout', 'recovered', 'backgrounded', 'current', 'left',
    'delivered', 'deleted', 'cleared', 'final', 'failed', 'cancelled', 'departed', 'suspended', 'ended',
    'completed', 'stopped', 'superseded'),
  path: choice('wifi', 'cellular', 'wired', 'other', 'none', 'unknown'),
  gap: number, viewing: bool, backgroundMs: number, firstContentMs: number, wsOpenMs: number, authedMs: number,
  listFreshMs: number, viewCurrentMs: number,
  code: v => typeof v === 'string' && /^-?\d{1,9}$/.test(v), // close code or NSError code (tag: may be negative)
  detectMs: number, reconnectMs: number, catchupMs: number, impactMs: number, visibleMs: number,
  pathChanged: bool, afterWake: bool, previousExit: choice('clean', 'unclean', 'first'),
  shown: choice('none', 'unconfirmed', 'failed'), shownMs: number, falseAlarm: bool, manualRetries: number,
  autoResends: number, offline: bool, background: bool, confirmMs: number, correctionMs: number,
  cause: v => typeof v === 'string' && /^[a-z_]{1,48}$/.test(v), // coarse class, never a message
  stage: choice('preflight', 'permission', 'lease', 'recording', 'finishing'),
  confirmed: bool, warm: bool, startMs: number, recordMs: number, finalizeMs: number, correctionOn: bool,
  // reply.summary (ReplyTracker)
  firstActivityMs: number, firstTextMs: number, deltas: number, maxGapMs: number, stalls: number,
  // ready.summary: the signed-in socket survived the background (no reconnect)
  kept: bool,
  // open.summary: opened while (re)connecting
  reconnecting: bool,
};
/** Adding an event requires consciously extending this allowlist and its native call site. */
export const schemas: Record<string, string[]> = {
  'app.launch': [],
  'app.phase': ['phase', 'pending'],
  'ws.state': ['state', 'attempt', 'source', 'count'],
  'ui.answer': ['questionId', 'origin', 'ix', 'clickCount', 'eventNumber', 'attempt'],
  'ui.mouse': ['questionId', 'phase', 'eventNumber', 'clickCount'],
  'cmd.answer': ['questionId', 'textLength', 'pending', 'duplicate', 'source', 'stack', 'ix'],
  'cmd.input': ['clientId', 'answerTo', 'textLength', 'attachments', 'ix', 'source'],
  'cmd.handoff': ['clientId', 'answerTo', 'accepted', 'stack'],
  'cmd.result': ['clientId', 'accepted'],
  'outbox.state': ['clientId', 'answerTo', 'phase', 'count'],
  'echo.input': ['clientId', 'answerTo', 'messageSeq', 'matched'],
  'diag.health': ['dropped', 'count', 'bytes'],
  'diag.upload': ['status', 'bytes', 'durationMs'],
  'work.slow': ['source', 'durationMs', 'messageSeq'],
  'ui.busy': ['durationMs'],
  'user.marker': [],
  'voice.action': ['source', 'textLength', 'accepted'],
  'list.snapshot': ['count', 'pending', 'firstSeq', 'lastSeq'],
  'session.view': ['source'],
  'ready.summary': ['kind', 'outcome', 'path', 'attempt', 'gap', 'viewing', 'backgroundMs', 'firstContentMs',
    'wsOpenMs', 'authedMs', 'listFreshMs', 'viewCurrentMs', 'previousExit', 'kept'],
  // A head (catch-up) reply arrived: request → handled on the main thread.
  'history.batch': ['kind', 'count', 'durationMs', 'viewing', 'attempt'],
  'open.summary': ['outcome', 'gap', 'firstContentMs', 'viewCurrentMs', 'reconnecting'],
  'send.summary': ['kind', 'outcome', 'shown', 'shownMs', 'falseAlarm', 'manualRetries', 'autoResends', 'restored',
    'offline', 'attachments', 'textLength', 'background', 'confirmMs', 'correctionMs', 'cause'],
  'voice.summary': ['outcome', 'stage', 'cause', 'confirmed', 'textLength', 'warm', 'count', 'startMs', 'recordMs',
    'finalizeMs', 'correctionOn'],
  'reply.summary': ['kind', 'outcome', 'durationMs', 'firstActivityMs', 'firstTextMs', 'deltas', 'maxGapMs', 'stalls'],
  'outage.summary': ['source', 'code', 'outcome', 'path', 'attempt', 'detectMs', 'reconnectMs', 'catchupMs',
    'impactMs', 'visibleMs', 'pathChanged', 'afterWake'],
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BATCH_KEYS = ['schema', 'batchId', 'processId', 'platform', 'version', 'build', 'events', 'image'];
const EVENT_KEYS = ['t', 'm', 'seq', 'ev', 'sid', 'd'];

/**
 * The batch to store, or null to reject it (400).
 *
 * Names the collector does not know yet — a top-level key, an event key, a
 * whole event type, or a field of a known event — are dropped, never stored.
 * A newer client is therefore not punished for one added field: before,
 * that rejected the whole batch, the client deleted it on 400, and every
 * event in it was lost (2026-10-01/02, `voice.summary.correctionOn`: 15
 * batches). A known name with a value outside its format still rejects the
 * batch: that is where free text or paths would leak.
 */
export function sanitizeDiagBatch(value: unknown, batchId: string): { batch: Record<string, unknown>; stripped: number } | null {
  if (!object(value)) return null;
  let stripped = 0;
  const strip = <T extends Record<string, unknown>>(o: T, allowed: (k: string) => boolean): T => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) { if (allowed(k)) out[k] = v; else stripped++; }
    return out as T;
  };
  const batch = strip(value, k => BATCH_KEYS.includes(k));
  if (batch.schema !== 1 || batch.batchId !== batchId || !uuid(batch.processId)) return null;
  if (!['ios', 'mac', 'windows', 'test'].includes(String(batch.platform))) return null;
  if (typeof batch.version !== 'string' || !/^[\d.]{1,32}$/.test(batch.version)) return null;
  if (typeof batch.build !== 'string' || !/^\d{1,16}$/.test(batch.build)) return null;
  if (batch.image !== undefined) {
    if (!object(batch.image)) return null;
    const image = strip(batch.image, k => ['uuid', 'base', 'os', 'arch'].includes(k));
    if (!uuid(image.uuid)
      || typeof image.base !== 'string' || !/^0x[\da-f]{1,16}$/i.test(image.base)
      || typeof image.os !== 'string' || !/^[\d.]{1,32}$/.test(image.os) || !['arm64', 'x86_64'].includes(String(image.arch))) return null;
    batch.image = image;
  }
  if (!Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > 1000) return null;
  const events: Record<string, unknown>[] = [];
  for (const raw of batch.events) {
    if (!object(raw)) return null;
    const event = strip(raw, k => EVENT_KEYS.includes(k));
    if (!number(event.t) || !number(event.m) || !Number.isSafeInteger(event.seq) || Number(event.seq) < 1) return null;
    if (event.sid !== undefined && !id(event.sid)) return null;
    if (typeof event.ev !== 'string' || !object(event.d)) return null;
    if (!Object.hasOwn(schemas, event.ev)) { stripped++; continue; }
    const schema = schemas[event.ev];
    const d = strip(event.d, k => schema.includes(k) && Object.hasOwn(fields, k));
    if (!Object.entries(d).every(([key, val]) => fields[key](val))) return null;
    events.push({ ...event, d });
  }
  batch.events = events;
  return { batch, stripped };
}

export function validateDiagBatch(value: unknown, batchId: string): boolean {
  return sanitizeDiagBatch(value, batchId) !== null;
}

export function diagSigningText(method: string, path: string, deviceId: string, timestamp: string, requestId: string, body: Buffer): string {
  return ['kraki-diag-v1', method, path, deviceId, timestamp, requestId, createHash('sha256').update(body).digest('hex')].join('\n');
}

/**
 * The client's IP. The collector listens on loopback only, behind the relay's
 * nginx/Caddy, so a loopback peer is the proxy and the rightmost
 * `X-Forwarded-For` entry is the address it saw (the same rule as Head's
 * `client-ip.ts`; this package does not import Head).
 */
export function diagClientIp(req: IncomingMessage): string {
  const strip = (a: string | undefined) => a?.startsWith('::ffff:') ? a.slice(7) : a;
  const peer = strip(req.socket.remoteAddress) ?? 'unknown';
  if (peer !== '127.0.0.1' && peer !== '::1') return peer;
  const header = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : header)?.split(',').map(p => p.trim()).filter(Boolean).at(-1);
  return strip(forwarded) ?? peer;
}

/** What a request's headers claim, checked except for the signature over the body. */
interface DiagHeaderClaims { device: DiagnosticDevice; deviceId: string; publicKey: string; timestamp: string; requestId: string; signature: string }

class HttpFailure extends Error { constructor(readonly status: number) { super(String(status)); } }

export interface DiagApiOptions {
  /** Unset means disabled, including auth and all filesystem work. Must be a dedicated private directory. */
  directory?: string;
  getDevice: (deviceId: string) => DiagnosticDevice | undefined;
  now?: () => number;
  dailyBytes?: number;
  /** Runtime kill switch (may be changed without touching normal relay traffic). */
  enabled?: () => boolean;
}

export class DiagApi {
  private readonly now: () => number;
  private active = 0;
  private activeByKey = new Map<string, number>();
  private buckets = new Map<string, { minute: number; count: number }>();
  private devicesWriting = new Set<string>();
  private retentionTimer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private usage = new Map<string, { day: string; bytes: number; files: number }>();

  constructor(private options: DiagApiOptions) {
    this.now = options.now ?? Date.now;
    if (options.directory) {
      this.retentionTimer = setInterval(() => { void this.sweep().catch(() => {}); }, 3600_000);
      this.retentionTimer.unref();
      void this.sweep().catch(() => {});
    }
  }

  close(): void { if (this.retentionTimer) clearInterval(this.retentionTimer); }

  private async enabled(): Promise<boolean> {
    if (this.options.enabled?.() === false) return false;
    // Operator can touch this file to stop collection without restarting Head.
    return !await access(join(this.options.directory!, 'DISABLED')).then(() => true, () => false);
  }

  private allow(key: string, limit: number): boolean {
    const minute = Math.floor(this.now() / 60_000);
    const prev = this.buckets.get(key);
    if (prev?.minute === minute) return ++prev.count <= limit;
    if (this.buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of this.buckets) if (v.minute !== minute) this.buckets.delete(k);
      if (this.buckets.size >= MAX_BUCKETS) return false;
    }
    this.buckets.set(key, { minute, count: 1 });
    return true;
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith(DIAG_PREFIX)) return false;
    res.setHeader('Cache-Control', 'no-store');
    // No access logging of headers/signatures, query strings or request body.
    let slots: string[] = [];
    try {
      if (!this.options.directory) throw new HttpFailure(410);
      if (!['batch', 'config'].includes(path.slice(DIAG_PREFIX.length))) throw new HttpFailure(404);
      const method = path.endsWith('/config') ? 'GET' : 'POST';
      if (req.method !== method || req.url !== path) throw new HttpFailure(405);
      const ip = diagClientIp(req);
      if (!this.allow(`ip:${ip}`, 120)) throw new HttpFailure(429);
      // Everything but the signature over the body is checked before the
      // body is read, so unauthenticated requests hold no upload slot.
      const claimed = this.authenticateHeaders(req);
      slots = this.takeSlots([`ip:${ip}`, `dev:${claimed.deviceId}`]);
      const body = method === 'POST' ? await this.readBody(req) : Buffer.alloc(0);
      const device = this.verifySignature(req, path, claimed, body);
      if (!this.allow(`dev:${device.id}`, 30)) throw new HttpFailure(429);
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ schema: 1, enabled: await this.enabled(), intervalSeconds: 60 }));
        return true;
      }
      if (!await this.enabled()) throw new HttpFailure(410);
      if (req.headers['content-encoding'] !== 'gzip' || req.headers['content-type'] !== 'application/json') throw new HttpFailure(415);
      let raw: Buffer;
      try { raw = await gunzip(body, { maxOutputLength: MAX_RAW }); }
      catch { throw new HttpFailure(413); }
      let batch: unknown;
      try { batch = JSON.parse(raw.toString('utf8')); } catch { throw new HttpFailure(400); }
      const batchId = req.headers['x-kraki-request'] as string;
      const clean = sanitizeDiagBatch(batch, batchId);
      if (!clean) throw new HttpFailure(400);
      if ((clean.batch.events as unknown[]).length === 0) { res.writeHead(204); res.end(); return true; }
      // Unchanged batches keep their exact bytes; a stripped one is stored
      // re-encoded (deterministic, so a retry of the same bytes stays idempotent).
      const stored = clean.stripped === 0 ? body : gzipSync(JSON.stringify(clean.batch));
      if (this.devicesWriting.has(device.id)) throw new HttpFailure(429);
      this.devicesWriting.add(device.id);
      try { await this.store(device, batchId, stored); }
      finally { this.devicesWriting.delete(device.id); }
      res.writeHead(204); res.end();
    } catch (error) {
      const status = error instanceof HttpFailure ? error.status : 503;
      if (status === 429 || status === 503) res.setHeader('Retry-After', '60');
      res.writeHead(status); res.end();
      // Drain rejected bodies; never retain or log them.
      req.resume();
    } finally { this.releaseSlots(slots); }
    return true;
  }

  /** Reserve one upload slot per key plus one of the process; 429 when any is full. */
  private takeSlots(keys: string[]): string[] {
    const limit = (key: string) => key.startsWith('dev:') ? MAX_ACTIVE_PER_DEVICE : MAX_ACTIVE_PER_IP;
    if (this.active >= MAX_ACTIVE || keys.some(key => (this.activeByKey.get(key) ?? 0) >= limit(key))) throw new HttpFailure(429);
    this.active++;
    for (const key of keys) this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1);
    return keys;
  }

  private releaseSlots(keys: string[]): void {
    if (!keys.length) return;
    this.active--;
    for (const key of keys) {
      const left = (this.activeByKey.get(key) ?? 1) - 1;
      if (left > 0) this.activeByKey.set(key, left); else this.activeByKey.delete(key);
    }
  }

  /** The request headers' claims: well-formed, fresh, and naming a registered app device. */
  private authenticateHeaders(req: IncomingMessage): DiagHeaderClaims {
    const deviceId = req.headers['x-kraki-device'];
    const timestamp = req.headers['x-kraki-time'];
    const requestId = req.headers['x-kraki-request'];
    const signature = req.headers['x-kraki-signature'];
    if (typeof deviceId !== 'string' || !id(deviceId) || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp)
      || !uuid(requestId) || typeof signature !== 'string' || signature.length > 1024
      || Math.abs(this.now() - Number(timestamp)) > 5 * 60_000) throw new HttpFailure(401);
    const device = this.options.getDevice(deviceId);
    if (!device?.publicKey || device.role !== 'app') throw new HttpFailure(401);
    return { device, deviceId, publicKey: device.publicKey, timestamp, requestId, signature };
  }

  private verifySignature(req: IncomingMessage, path: string, claimed: DiagHeaderClaims, body: Buffer): DiagnosticDevice {
    const { device, deviceId, publicKey, timestamp, requestId, signature } = claimed;
    try {
      const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----\n`;
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'rsa' || !verify('sha256', Buffer.from(diagSigningText(req.method!, path, deviceId, timestamp, requestId, body)), key, Buffer.from(signature, 'base64'))) throw new Error('signature');
    } catch { throw new HttpFailure(401); }
    return device;
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    if (Number(req.headers['content-length'] ?? 0) > MAX_WIRE) return Promise.reject(new HttpFailure(413));
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cleanup = () => {
        clearTimeout(timer);
        req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', error);
      };
      const error = () => { cleanup(); reject(new HttpFailure(400)); };
      const data = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_WIRE) { cleanup(); reject(new HttpFailure(413)); }
        else chunks.push(chunk);
      };
      const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
      const timer = setTimeout(() => { cleanup(); reject(new HttpFailure(408)); }, 10_000);
      req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', error);
    });
  }

  private async store(device: DiagnosticDevice, batchId: string, body: Buffer): Promise<void> {
    // Server-derived opaque path components: no client path or account name.
    const owner = createHash('sha256').update(`${device.userId}\n${device.id}`).digest('hex');
    const directory = join(this.options.directory!, owner);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Stable name makes retransmission idempotent, even across restarts/day boundaries.
    const file = join(directory, `${batchId.toLowerCase()}.json.gz`);
    try {
      const previous = await readFile(file);
      if (!previous.equals(body)) throw new HttpFailure(409);
      return;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const today = new Date(this.now()).toISOString().slice(0, 10);
    let usage = this.usage.get(owner);
    if (usage?.day !== today) {
      usage = { day: today, bytes: 0, files: 0 };
      // Once per device/day/process, not O(number of logs) on every upload.
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const info = await stat(join(directory, entry.name)).catch(() => undefined);
        if (info && new Date(info.mtimeMs).toISOString().slice(0, 10) === today) { usage.bytes += info.size; usage.files++; }
      }
      if (this.usage.size >= 4096) this.usage.delete(this.usage.keys().next().value!);
      this.usage.set(owner, usage);
    }
    if (usage.bytes + body.length > (this.options.dailyBytes ?? DAILY_BYTES) || usage.files >= 2048) throw new HttpFailure(429);
    // Leave headroom for relay SQLite/WAL even if the diagnostics volume is shared.
    const fs = await statfs(directory);
    if (fs.bavail * fs.bsize < 1024 * 1024 * 1024) throw new HttpFailure(507);
    const temporary = `${file}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, file);
    usage.bytes += body.length; usage.files++;
  }

  /** Sweeps inactive devices too; async, hourly, symlinks ignored. Dedicated directory only. */
  async sweep(): Promise<void> {
    if (!this.options.directory || this.sweeping) return;
    this.sweeping = true;
    try {
      const owners = await readdir(this.options.directory, { withFileTypes: true }).catch(() => []);
      for (const owner of owners) {
        if (!owner.isDirectory() || !/^[\da-f]{64}$/.test(owner.name)) continue;
        const directory = join(this.options.directory, owner.name);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !/^[\da-f-]+\.json\.gz(?:\.tmp)?$/.test(entry.name)) continue;
          const path = join(directory, entry.name);
          const info = await stat(path).catch(() => undefined);
          if (info && info.mtimeMs < this.now() - RETENTION_MS) await rm(path, { force: true });
        }
      }
    } finally { this.sweeping = false; }
  }
}
