/** Metadata-only ports of ExperienceTrackers.swift. All clocks use milliseconds. */
export interface VoiceSummary {
  outcome: 'final' | 'failed' | 'cancelled' | 'departed' | 'suspended' | 'ended';
  stage: 'preflight' | 'permission' | 'lease' | 'recording' | 'finishing';
  cause?: string;
  startMs?: number;
  recordMs?: number;
  finalizeMs?: number;
  correctionConfirmed: boolean;
  correctionEnabled: boolean;
  textLength: number;
  warm: boolean;
  leaseRollovers: number;
}

export class VoiceTracker {
  now: () => number = () => performance.now();
  onSummary?: (s: VoiceSummary) => void;
  private current: VoiceSummary | null = null;
  private began = 0;
  private recordingAt: number | null = null;
  private finishingAt: number | null = null;
  private pendingOutcome: VoiceSummary['outcome'] | null = null;

  /** Identity reset discards an attempt, never emits its summary. */
  reset(): void {
    this.current = null;
    this.began = 0;
    this.recordingAt = this.finishingAt = null;
    this.pendingOutcome = null;
  }

  begin(warm: boolean, correctionEnabled = true): void {
    this.current = { outcome: 'ended', stage: 'preflight', correctionConfirmed: false,
      correctionEnabled, textLength: 0, warm, leaseRollovers: 0 };
    this.began = this.now();
    this.recordingAt = this.finishingAt = null;
    this.pendingOutcome = null;
  }

  stateChanged(state: string): void {
    if (!this.current) return;
    const t = this.now();
    switch (state) {
      case 'requestingPermission': this.current.stage = 'permission'; break;
      case 'obtainingLease': this.current.stage = 'lease'; break;
      case 'recording':
        this.current.stage = 'recording';
        if (this.recordingAt === null) {
          this.recordingAt = t;
          this.current.startMs = t - this.began;
        }
        break;
      case 'finishing':
        this.current.stage = 'finishing';
        this.finishingAt = t;
        if (this.recordingAt !== null) this.current.recordMs = t - this.recordingAt;
        break;
      case 'failed': this.end('failed', t); break;
      case 'idle': this.end(this.pendingOutcome ?? 'ended', t); break;
    }
  }

  cause(tag: string): void { if (this.current) this.current.cause = tag; }
  outcome(outcome: VoiceSummary['outcome'], overwrite = true): void {
    if (this.current && (overwrite || this.pendingOutcome === null)) this.pendingOutcome = outcome;
  }
  rollover(): void { if (this.current) this.current.leaseRollovers += 1; }
  finalReceived(textLength: number, correctionConfirmed: boolean): void {
    if (!this.current) return;
    this.current.textLength = textLength;
    this.current.correctionConfirmed = correctionConfirmed;
    this.pendingOutcome = 'final';
  }

  private end(outcome: VoiceSummary['outcome'], t: number): void {
    const summary = this.current;
    if (!summary) return;
    this.current = null;
    summary.outcome = outcome;
    if (this.finishingAt !== null) summary.finalizeMs = t - this.finishingAt;
    else if (this.recordingAt !== null && summary.recordMs === undefined) summary.recordMs = t - this.recordingAt;
    this.onSummary?.(summary);
  }

  /** Coarse gateway/broker failure class; never include the reason itself. */
  static classify(reason: string): string {
    const lower = reason.toLowerCase();
    if (lower.includes('permission')) return 'permission';
    if (lower.includes('audio input unavailable')) return 'mic_unavailable';
    if (lower.includes('audio capture stalled')) return 'capture_stalled';
    if (lower.includes('audio input changed') || lower.includes('audio input format')) return 'capture_interrupted';
    if (lower.includes('voice upload')) return 'upload_stalled';
    if (lower.includes('asr closed without final') || lower.includes('asr_closed_without_final')) return 'asr_final_missing';
    if (lower.includes('quota')) return 'quota';
    if (['lease', 'denied', 'authorization', 'signature', 'wrong_'].some((s) => lower.includes(s))) return 'lease_rejected';
    if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';
    if (['network', 'ws ', 'socket', 'connection'].some((s) => lower.includes(s))) return 'network';
    return 'gateway';
  }
}

export interface ReplySummary {
  kind: 'typed' | 'answer';
  outcome: 'completed' | 'failed' | 'stopped' | 'backgrounded' | 'superseded' | 'abandoned';
  firstActivityMs?: number;
  firstTextMs?: number;
  durationMs: number;
  deltas: number;
  maxGapMs: number;
  stalls: number;
}

export class ReplyTracker {
  static readonly stallMs = 3000;
  static readonly maxAge = 3600_000;
  static readonly maxOpen = 32;
  now: () => number = () => performance.now();
  onSummary?: (s: ReplySummary) => void;
  private entries = new Map<string, { summary: ReplySummary; startedAt: number; lastDeltaAt: number | null }>();

  reset(): void { this.entries.clear(); }

  started(sessionId: string, kind: ReplySummary['kind']): void {
    this.expire();
    this.finish(sessionId, 'superseded');
    while (this.entries.size >= ReplyTracker.maxOpen) {
      const oldest = [...this.entries].reduce((a, b) => a[1].startedAt <= b[1].startedAt ? a : b)[0];
      this.finish(oldest, 'abandoned');
    }
    this.entries.set(sessionId, { summary: { kind, outcome: 'completed', durationMs: 0, deltas: 0, maxGapMs: 0, stalls: 0 },
      startedAt: this.now(), lastDeltaAt: null });
  }

  expire(): void {
    const t = this.now();
    for (const [id, entry] of this.entries) if (t - entry.startedAt > ReplyTracker.maxAge) this.finish(id, 'abandoned');
  }
  missedEnd(sessionId: string): void { this.finish(sessionId, 'abandoned'); }
  get openSessions(): string[] { return [...this.entries.keys()]; }

  activity(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.summary.firstActivityMs ??= this.now() - e.startedAt;
    e.lastDeltaAt = null;
  }
  delta(sessionId: string, reset: boolean, empty = false): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    if (empty) { e.lastDeltaAt = null; return; }
    const t = this.now();
    e.summary.firstActivityMs ??= t - e.startedAt;
    e.summary.firstTextMs ??= t - e.startedAt;
    e.summary.deltas += 1;
    if (e.lastDeltaAt !== null && !reset) {
      const gap = t - e.lastDeltaAt;
      e.summary.maxGapMs = Math.max(e.summary.maxGapMs, gap);
      if (gap >= ReplyTracker.stallMs) e.summary.stalls += 1;
    }
    e.lastDeltaAt = t;
  }
  message(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    this.activity(sessionId);
    e.summary.firstTextMs ??= this.now() - e.startedAt;
  }
  finish(sessionId: string, outcome: ReplySummary['outcome']): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    this.entries.delete(sessionId);
    e.summary.outcome = outcome;
    e.summary.durationMs = this.now() - e.startedAt;
    this.onSummary?.(e.summary);
  }
  backgrounded(): void { for (const id of this.openSessions) this.finish(id, 'backgrounded'); }
  get inFlight(): number { return this.entries.size; }
}
