/**
 * Performance data ("Share Performance Data") for Kraki for Windows: the same
 * vocabulary, batch format and limits as native KrakiDiag (DiagRecorder.swift).
 *
 * Metadata only: event names, ids, counts, durations and coarse tags. Never
 * message text, drafts, voice, attachments, file names or error strings.
 * Keep in sync with the collector allowlist in packages/monitor/src/diag-api.ts
 * (enforced by packages/monitor/src/__tests__/schema-sync.test.ts).
 */

export const DIAG_EVENTS = {
  launch: 'app.launch',
  phase: 'app.phase',
  connection: 'ws.state',
  answer: 'cmd.answer',
  input: 'cmd.input',
  outbox: 'outbox.state',
  echo: 'echo.input',
  health: 'diag.health',
  upload: 'diag.upload',
  ready: 'ready.summary',
  outage: 'outage.summary',
  open: 'open.summary',
  send: 'send.summary',
} as const;
export type DiagEventName = (typeof DIAG_EVENTS)[keyof typeof DIAG_EVENTS];

/** Every field this client may send (each has a collector validator). */
export const DIAG_FIELDS = [
  'clientId', 'questionId', 'answerTo', 'phase', 'state', 'source',
  'textLength', 'attachments', 'pending', 'messageSeq', 'matched', 'duplicate',
  'restored', 'count', 'dropped', 'attempt', 'status', 'bytes',
  'kind', 'outcome', 'path', 'gap', 'viewing', 'backgroundMs', 'firstContentMs', 'wsOpenMs', 'authedMs',
  'listFreshMs', 'viewCurrentMs', 'code', 'detectMs', 'reconnectMs', 'catchupMs', 'impactMs', 'visibleMs',
  'pathChanged', 'afterWake', 'previousExit',
  'shown', 'shownMs', 'falseAlarm', 'manualRetries', 'autoResends', 'offline', 'background', 'confirmMs', 'correctionMs', 'cause',
] as const;
export type DiagField = (typeof DIAG_FIELDS)[number];
export type DiagValue = string | number | boolean;

export interface DiagEvent {
  t: number;
  m: number;
  seq: number;
  ev: DiagEventName;
  sid?: string;
  d: Partial<Record<DiagField, DiagValue>>;
}

/** Like DiagValue.encode: ids/tags capped, numbers finite and non-negative. */
function clean(fields: Partial<Record<DiagField, DiagValue | undefined>>): Partial<Record<DiagField, DiagValue>> {
  const out: Partial<Record<DiagField, DiagValue>> = {};
  for (const [k, v] of Object.entries(fields) as [DiagField, DiagValue | undefined][]) {
    if (v === undefined) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 512);
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? Math.max(0, v) : 0;
    else out[k] = v;
  }
  return out;
}

/** Bounded, nonblocking producer queue (native DiagRecorder): at most
 *  `capacity` pending and `perSecond` admitted per second; excess is dropped
 *  and counted, never queued without limit. */
export class DiagRecorder {
  private pending: DiagEvent[] = [];
  private enabled = true;
  private sequence = 0;
  private dropped = 0;
  private second = -1;
  private admitted = 0;
  readonly processId = crypto.randomUUID();

  constructor(
    readonly capacity = 1024,
    readonly perSecond = 200,
    private readonly mono: () => number = () => performance.now(),
  ) {}

  record(ev: DiagEventName, sid: string | undefined, fields: Partial<Record<DiagField, DiagValue | undefined>> = {}): boolean {
    if (!this.enabled) return false;
    this.sequence += 1;
    const m = this.mono();
    const s = Math.floor(m / 1000);
    if (s !== this.second) { this.second = s; this.admitted = 0; }
    if (this.pending.length >= this.capacity || this.admitted >= this.perSecond) { this.dropped += 1; return false; }
    this.admitted += 1;
    this.pending.push({ t: Date.now(), m, seq: this.sequence, ev, ...(sid ? { sid: sid.slice(0, 128) } : {}), d: clean(fields) });
    return true;
  }

  get isEnabled(): boolean { return this.enabled; }

  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) { this.pending = []; this.dropped = 0; }
  }

  drain(): { events: DiagEvent[]; dropped: number } {
    const out = { events: this.pending, dropped: this.dropped };
    this.pending = [];
    this.dropped = 0;
    return out;
  }
}
