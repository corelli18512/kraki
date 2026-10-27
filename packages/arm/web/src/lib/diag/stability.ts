/**
 * Stability summaries — a port of native StabilityTracker.swift
 * (docs/stability-metrics.md): one `ready.summary` per app opening, one
 * `outage.summary` per foreground connection outage, one `open.summary` per
 * conversation opened while online. Durations, counts and tags only.
 */

export interface ReadySummary {
  kind: 'cold' | 'warm' | 'wake';
  backgroundMs?: number;
  firstContentMs?: number;
  wsOpenMs?: number;
  authedMs?: number;
  listFreshMs?: number;
  viewCurrentMs?: number;
  attempts: number;
  gap: number;
  viewing: boolean;
  path: string;
  outcome: 'ready' | 'abandoned' | 'timeout';
  previousExit?: string;
}
export interface OpenSummary {
  firstContentMs?: number;
  currentMs?: number;
  gap: number;
  /** Opened while an app-open or outage record was in progress. */
  reconnecting: boolean;
  outcome: 'current' | 'left' | 'timeout';
}
export interface OutageSummary {
  reason: string;
  code?: number;
  detectMs: number;
  reconnectMs?: number;
  catchupMs?: number;
  impactMs?: number;
  visibleMs: number;
  attempts: number;
  path: string;
  pathChanged: boolean;
  afterWake: boolean;
  outcome: 'recovered' | 'backgrounded' | 'abandoned';
}

export class StabilityTracker {
  static readonly readyTimeout = 30_000;
  static readonly outageGiveUp = 600_000;

  now: () => number = () => performance.now();
  schedule: (ms: number, work: () => void) => void = (ms, work) => { setTimeout(work, ms); };
  onReady?: (r: ReadySummary) => void;
  onOutage?: (o: OutageSummary) => void;
  onOpen?: (o: OpenSummary) => void;
  previousExit?: () => string;

  path = 'unknown';
  private everVisible = false;
  private hiddenAt: number | null = null;
  private asleepAt: number | null = null;
  private everAuthenticated = false;
  private lastPathChange: number | null = null;
  private lastWake: number | null = null;
  private readySince: number | null = null;
  private ready: ReadySummary | null = null;
  private readyConnects = 0;
  private outageLast = 0;
  private outageDetected = 0;
  private outageReauthed: number | null = null;
  private outage: OutageSummary | null = null;
  private reconnectingShownAt: number | null = null;
  private awaitingList = false;
  private target: { sessionId: string; seq: number } | null = null;
  private opening: { sessionId: string; since: number; target: number; value: OpenSummary } | null = null;
  private generation = 0;
  private openGeneration = 0;

  /** Discard identity-bound milestones and invalidate their timers without summaries.
   * Keep the process exit marker, current network path, clocks and callbacks. */
  reset(): void {
    this.generation += 1;
    this.openGeneration += 1;
    this.everVisible = this.everAuthenticated = false;
    this.hiddenAt = this.asleepAt = this.lastPathChange = this.lastWake = null;
    this.readySince = null;
    this.ready = null;
    this.readyConnects = this.outageLast = this.outageDetected = 0;
    this.outageReauthed = null;
    this.outage = null;
    this.reconnectingShownAt = null;
    this.awaitingList = false;
    this.target = null;
    this.opening = null;
  }

  appVisible(hasCachedContent: boolean, viewing: boolean): void {
    if (this.asleepAt !== null) {
      const asleep = this.asleepAt;
      this.asleepAt = null;
      this.lastWake = this.now();
      this.begin('wake', asleep, true, viewing);
      return;
    }
    if (!this.everVisible) {
      this.everVisible = true;
      this.begin('cold', null, hasCachedContent, viewing);
    } else if (this.hiddenAt !== null) {
      const hidden = this.hiddenAt;
      this.hiddenAt = null;
      this.begin('warm', hidden, true, viewing);
    }
  }

  appHidden(): void {
    if (this.hiddenAt !== null) return;
    this.hiddenAt = this.now();
    this.finishOpen('left');
    this.finishReady('abandoned');
    this.finishOutage('backgrounded');
  }

  systemWillSleep(): void {
    this.asleepAt = this.now();
    this.finishOpen('left');
    this.finishReady('abandoned');
    this.finishOutage('backgrounded');
  }

  pathChanged(next: string): void {
    if (next === this.path) return;
    if (this.path !== 'unknown') this.lastPathChange = this.now();
    this.path = next;
  }

  connecting(): void {
    if (this.ready) {
      this.readyConnects += 1;
      this.ready.attempts = Math.max(0, this.readyConnects - 1);
    }
    if (this.outage && this.outageReauthed === null) this.outage.attempts += 1;
  }

  socketOpen(): void {
    if (this.readySince !== null && this.ready && this.ready.wsOpenMs === undefined) this.ready.wsOpenMs = this.ms(this.readySince);
  }

  transportLost(reason: string, code: number | undefined, quietForMs: number | undefined): void {
    if (this.hiddenAt !== null || this.asleepAt !== null || !this.everAuthenticated || this.ready) return;
    if (this.outage) {
      if (this.outageReauthed !== null) {
        this.outageReauthed = null;
        this.awaitingList = false;
        this.target = null;
      }
      return;
    }
    this.finishOpen('left');
    const t = this.now();
    let last = t - Math.max(0, quietForMs ?? 0);
    if (this.lastWake !== null) last = Math.max(last, this.lastWake);
    this.outageLast = last;
    this.outageDetected = t;
    this.outageReauthed = null;
    this.outage = {
      reason, code, detectMs: t - last, visibleMs: 0, attempts: 0, path: this.path,
      pathChanged: this.lastPathChange !== null && t - this.lastPathChange <= 10_000,
      afterWake: this.lastWake !== null && t - this.lastWake <= 60_000,
      outcome: 'recovered',
    };
    if (this.reconnectingShownAt !== null) this.reconnectingShownAt = t;
    const token = ++this.generation;
    this.schedule(StabilityTracker.outageGiveUp, () => { if (this.generation === token) this.finishOutage('abandoned'); });
  }

  authenticated(): void {
    this.everAuthenticated = true;
    if (this.readySince !== null && this.ready) {
      if (this.ready.authedMs === undefined) this.ready.authedMs = this.ms(this.readySince);
      this.awaitingList = true;
    } else if (this.outage) {
      this.outageReauthed = this.now();
      this.outage.reconnectMs = this.now() - this.outageDetected;
      this.awaitingList = true;
    }
  }

  sessionListApplied(viewed: { sessionId: string; lastSeq: number; localSeq: number } | null): void {
    if (!this.awaitingList) return;
    this.awaitingList = false;
    if (this.readySince !== null && this.ready && this.ready.listFreshMs === undefined) {
      this.ready.listFreshMs = this.ms(this.readySince);
      if (this.ready.firstContentMs === undefined) this.ready.firstContentMs = this.ms(this.readySince);
    }
    if (!viewed || viewed.localSeq >= viewed.lastSeq) { this.reachedCurrent(); return; }
    if (this.ready) this.ready.gap = viewed.lastSeq - viewed.localSeq;
    this.target = { sessionId: viewed.sessionId, seq: viewed.lastSeq };
  }

  get wantsConversationUpdates(): boolean { return !!this.ready || !!this.target || !!this.opening; }

  /** A tap while (re)connecting is recorded too, flagged `reconnecting`
   * (native: "reconnected, opened the chat, Syncing…"). */
  conversationOpened(sessionId: string, lastSeq: number, localSeq: number, online: boolean): void {
    this.finishOpen('left');
    const reconnecting = !!this.ready || !!this.outage;
    // Offline with no reconnect in progress: nothing to wait for.
    if (!(online || reconnecting) || this.hiddenAt !== null || this.asleepAt !== null) return;
    this.opening = { sessionId, since: this.now(), target: lastSeq, value: { gap: Math.max(0, lastSeq - localSeq), reconnecting, outcome: 'current' } };
    // Its own counter: an opening must not cancel the ready/outage timeout.
    const token = ++this.openGeneration;
    this.schedule(StabilityTracker.readyTimeout, () => { if (this.openGeneration === token) this.finishOpen('timeout'); });
  }

  conversationRendered(sessionId: string, localSeq: number, lastSeq: number, hasContent: boolean): void {
    if (hasContent && this.readySince !== null && this.ready && this.ready.firstContentMs === undefined) {
      this.ready.firstContentMs = this.ms(this.readySince);
    }
    const open = this.opening;
    if (open && open.sessionId === sessionId) {
      if (hasContent && open.value.firstContentMs === undefined) open.value.firstContentMs = this.ms(open.since);
      if (localSeq >= Math.max(open.target, lastSeq)) {
        open.value.currentMs = this.ms(open.since);
        this.finishOpen('current');
      }
    }
    if (!this.target) return;
    if (this.target.sessionId !== sessionId) this.target = { sessionId, seq: lastSeq };
    if (localSeq >= this.target.seq) this.reachedCurrent();
  }

  reconnectingShown(shown: boolean): void {
    if (shown && this.reconnectingShownAt === null) this.reconnectingShownAt = this.now();
    else if (!shown && this.reconnectingShownAt !== null) {
      const since = this.reconnectingShownAt;
      this.reconnectingShownAt = null;
      if (this.outage) this.outage.visibleMs += this.ms(since);
    }
  }

  private begin(kind: ReadySummary['kind'], since: number | null, hasCachedContent: boolean, viewing: boolean): void {
    this.finishOpen('left');
    this.finishReady('abandoned');
    this.finishOutage('backgrounded');
    const t = this.now();
    this.readySince = t;
    this.readyConnects = 0;
    this.target = null;
    this.awaitingList = false;
    this.ready = {
      kind, ...(since !== null ? { backgroundMs: t - since } : {}),
      ...(hasCachedContent ? { firstContentMs: 0 } : {}),
      attempts: 0, gap: 0, viewing, path: this.path, outcome: 'ready',
      ...(kind === 'cold' && this.previousExit ? { previousExit: this.previousExit() } : {}),
    };
    const token = ++this.generation;
    this.schedule(StabilityTracker.readyTimeout, () => { if (this.generation === token) this.finishReady('timeout'); });
  }

  private reachedCurrent(): void {
    this.target = null;
    if (this.readySince !== null && this.ready) {
      this.ready.viewCurrentMs = this.ms(this.readySince);
      this.finishReady('ready');
    } else if (this.outage && this.outageReauthed !== null) {
      this.outage.catchupMs = this.now() - this.outageReauthed;
      this.outage.impactMs = this.now() - this.outageLast;
      this.finishOutage('recovered');
    }
  }

  private finishReady(outcome: ReadySummary['outcome']): void {
    const value = this.ready;
    if (!value) return;
    this.ready = null; this.readySince = null; this.target = null; this.awaitingList = false;
    value.outcome = outcome;
    this.onReady?.(value);
  }

  private finishOpen(outcome: OpenSummary['outcome']): void {
    const value = this.opening?.value;
    if (!value) return;
    this.opening = null;
    value.outcome = outcome;
    this.onOpen?.(value);
  }

  private finishOutage(outcome: OutageSummary['outcome']): void {
    const value = this.outage;
    if (!value) return;
    if (this.reconnectingShownAt !== null) {
      value.visibleMs += this.ms(this.reconnectingShownAt);
      this.reconnectingShownAt = this.now();
    }
    this.outage = null; this.outageReauthed = null; this.target = null; this.awaitingList = false;
    value.outcome = outcome;
    this.onOutage?.(value);
  }

  private ms(since: number): number { return this.now() - since; }
}

/** SendTracker.swift: one `send.summary` per input, creation → end. */
export interface SendSummary {
  kind: 'typed' | 'voice' | 'answer' | 'steer';
  outcome: 'delivered' | 'deleted' | 'cleared';
  confirmMs?: number;
  correctionMs?: number;
  shown: 'none' | 'unconfirmed' | 'failed';
  shownMs: number;
  cause?: string;
  failedInBackground: boolean;
  manualRetries: number;
  autoResends: number;
  restored: boolean;
  offlineAtSend: boolean;
  attachments: number;
  textLength: number;
}

export class SendTracker {
  now: () => number = Date.now;
  onSummary?: (s: SendSummary) => void;
  private entries = new Map<string, { summary: SendSummary; createdAt: number; shownSince: number | null }>();

  private blank(kind: SendSummary['kind']): SendSummary {
    return { kind, outcome: 'delivered', shown: 'none', shownMs: 0, failedInBackground: false, manualRetries: 0,
      autoResends: 0, restored: false, offlineAtSend: false, attachments: 0, textLength: 0 };
  }

  reset(): void { this.entries.clear(); }

  created(clientId: string, kind: SendSummary['kind'], textLength: number, attachments: number, pathUp: boolean): void {
    this.entries.set(clientId, { summary: { ...this.blank(kind), offlineAtSend: !pathUp, attachments, textLength }, createdAt: this.now(), shownSince: null });
  }
  restored(clientId: string, kind: SendSummary['kind'], createdAt: number | undefined, failed: boolean): void {
    if (this.entries.has(clientId)) return;
    const entry = { summary: { ...this.blank(kind), restored: true }, createdAt: createdAt ?? this.now(), shownSince: null as number | null };
    if (failed) { entry.summary.shown = 'failed'; entry.shownSince = this.now(); }
    this.entries.set(clientId, entry);
  }
  dispatched(clientId: string): void {
    const e = this.entries.get(clientId);
    if (e && e.summary.correctionMs === undefined) e.summary.correctionMs = this.now() - e.createdAt;
  }
  state(clientId: string, state: string, cause?: string, inBackground = false): void {
    const e = this.entries.get(clientId);
    if (!e) return;
    const problem = state === 'failed' ? 'failed' : state === 'unconfirmed' ? 'unconfirmed' : null;
    if (problem) {
      e.shownSince ??= this.now();
      if (problem === 'failed' || e.summary.shown === 'none') e.summary.shown = problem;
      if (cause) e.summary.cause = cause;
      if (problem === 'failed') e.summary.failedInBackground = inBackground;
    } else if (e.shownSince !== null) {
      e.summary.shownMs += this.now() - e.shownSince;
      e.shownSince = null;
    }
  }
  retried(clientId: string, manual: boolean): void {
    const e = this.entries.get(clientId);
    if (!e) return;
    if (manual) e.summary.manualRetries += 1; else e.summary.autoResends += 1;
  }
  finished(clientId: string, outcome: SendSummary['outcome']): void {
    const e = this.entries.get(clientId);
    if (!e) return;
    this.entries.delete(clientId);
    const t = this.now();
    if (e.shownSince !== null) e.summary.shownMs += t - e.shownSince;
    e.summary.outcome = outcome;
    if (outcome === 'delivered') e.summary.confirmMs = t - e.createdAt;
    this.onSummary?.(e.summary);
  }
  get inFlight(): number { return this.entries.size; }
}

export const sendFalseAlarm = (s: SendSummary) => s.shown !== 'none' && s.outcome === 'delivered' && s.manualRetries === 0;
