/**
 * Performance data facade (native KrakiDiag). Active only inside the Windows
 * shell, which provides the HTTP bridge; in a browser every call is a no-op.
 */
import { desktop } from '../desktop';
import { DiagClient, type DiagHttp } from './client';
import { DiagRecorder, type DiagEventName, type DiagField, type DiagValue } from './recorder';
import { IdbSpoolStore } from './spool';
import { SendTracker, StabilityTracker, sendFalseAlarm } from './stability';

type Fields = Partial<Record<DiagField, DiagValue | undefined>>;

const RUNNING_KEY = 'kraki.diag.running';
/** Events that are worth writing to disk soon (native KrakiDiag.record). */
const FLUSH_SOON = new Set<DiagEventName>(['cmd.answer', 'cmd.input', 'outbox.state', 'echo.input', 'app.phase', 'ready.summary', 'outage.summary', 'open.summary', 'send.summary']);

class Diag {
  readonly stability = new StabilityTracker();
  readonly sends = new SendTracker();
  private recorder: DiagRecorder | null = null;
  private client: DiagClient | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Wire up once at startup. `http` absent: diagnostics stay off (browser). */
  start(http: DiagHttp | undefined, info: { version: string; build: string }): void {
    if (!http || this.client) return;
    this.recorder = new DiagRecorder();
    this.client = new DiagClient({
      recorder: this.recorder, store: new IdbSpoolStore(), http,
      platform: 'windows', version: info.version, build: info.build, storage: localStorage,
    });
    // How the previous process ended, read before this one marks itself.
    const was = localStorage.getItem(RUNNING_KEY);
    const previousExit = was === null ? 'first' : was === '1' ? 'unclean' : 'clean';
    localStorage.setItem(RUNNING_KEY, '1');
    window.addEventListener('pagehide', () => localStorage.setItem(RUNNING_KEY, '0'));
    this.stability.previousExit = () => previousExit;
    this.stability.onReady = (r) => this.record('ready.summary', undefined, {
      kind: r.kind, outcome: r.outcome, path: r.path, attempt: r.attempts, gap: r.gap, viewing: r.viewing,
      backgroundMs: r.backgroundMs, firstContentMs: r.firstContentMs, wsOpenMs: r.wsOpenMs, authedMs: r.authedMs,
      listFreshMs: r.listFreshMs, viewCurrentMs: r.viewCurrentMs, previousExit: r.previousExit,
    });
    this.stability.onOutage = (o) => this.record('outage.summary', undefined, {
      source: o.reason, outcome: o.outcome, path: o.path, attempt: o.attempts, detectMs: o.detectMs,
      visibleMs: o.visibleMs, pathChanged: o.pathChanged, afterWake: o.afterWake,
      code: o.code === undefined ? undefined : String(o.code),
      reconnectMs: o.reconnectMs, catchupMs: o.catchupMs, impactMs: o.impactMs,
    });
    this.stability.onOpen = (o) => this.record('open.summary', undefined, {
      outcome: o.outcome, gap: o.gap, firstContentMs: o.firstContentMs, viewCurrentMs: o.currentMs,
    });
    this.sends.onSummary = (s) => this.record('send.summary', undefined, {
      kind: s.kind, outcome: s.outcome, shown: s.shown, shownMs: s.shownMs, falseAlarm: sendFalseAlarm(s),
      manualRetries: s.manualRetries, autoResends: s.autoResends, restored: s.restored ? 1 : 0,
      offline: s.offlineAtSend, attachments: s.attachments, textLength: s.textLength, background: s.failedInBackground,
      confirmMs: s.confirmMs, correctionMs: s.correctionMs, cause: s.cause,
    });
    const path = () => {
      const type = (navigator as { connection?: { type?: string } }).connection?.type;
      if (!navigator.onLine) return 'none';
      return type === 'wifi' ? 'wifi' : type === 'ethernet' ? 'wired' : type === 'cellular' ? 'cellular' : type ? 'other' : 'unknown';
    };
    this.stability.pathChanged(path());
    window.addEventListener('online', () => this.stability.pathChanged(path()));
    window.addEventListener('offline', () => this.stability.pathChanged(path()));
    const visible = () => document.visibilityState === 'visible';
    document.addEventListener('visibilitychange', () => {
      this.phase(visible() ? 'active' : 'background');
      if (visible()) this.stability.appVisible(true, location.pathname.startsWith('/session/'));
      else this.stability.appHidden();
    });
    this.client.start();
    this.record('app.launch');
    if (visible()) this.stability.appVisible(false, location.pathname.startsWith('/session/'));
    else this.client.setForeground(false);
  }

  get active(): boolean { return !!this.client; }
  get enabled(): boolean { return this.client?.enabled ?? false; }

  record(ev: DiagEventName, sid?: string, fields: Fields = {}): void {
    if (!this.recorder?.record(ev, sid, fields) || !FLUSH_SOON.has(ev) || this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.client?.flush(); }, 250);
  }

  configure(relay: string, device: string, sign: (message: string) => Promise<string>): void {
    void this.client?.configure(relay, device, sign);
    this.phase('authenticated');
  }

  phase(phase: string, pending = 0): void {
    this.record('app.phase', undefined, { phase, pending });
    if (phase === 'active') this.client?.setForeground(true);
    if (phase === 'background') this.client?.setForeground(false);
    if (phase === 'logout') this.client?.logout();
  }

  userActivity(): void { this.client?.userActivity(); }

  async setEnabled(enabled: boolean): Promise<void> { await this.client?.setEnabled(enabled); }
}

export const diag = new Diag();

/** Desktop bridge → DiagHttp; undefined outside the Windows shell. */
export function desktopDiagHttp(): DiagHttp | undefined {
  const bridge = desktop?.diag;
  return bridge ? (req) => bridge.request(req) : undefined;
}

export function desktopBuildNumber(): string {
  const run = desktop?.buildInfo?.runId;
  return run && /^\d{1,16}$/.test(run) ? run : '0';
}
