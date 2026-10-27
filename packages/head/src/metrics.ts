/**
 * Relay health numbers for operations (kraki-watch alerting, daily summary).
 *
 * Counts and timings only: never device ids, user ids, IPs or payload data.
 * Read from `/internal/metrics`, which answers loopback requests only (see
 * `observability.ts`); the public relay exposes nothing beyond `/health/ready`.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/** Upper bounds (ms) of the latency buckets; the last bucket is open-ended. */
export const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500] as const;

export class LatencyHistogram {
  readonly counts: number[] = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
  total = 0;
  sumMs = 0;
  maxMs = 0;

  observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let i = LATENCY_BUCKETS_MS.findIndex((bound) => ms <= bound);
    if (i < 0) i = LATENCY_BUCKETS_MS.length;
    this.counts[i]++;
    this.total++;
    this.sumMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  /** Upper bound of the bucket holding quantile `q` (0–1); null when empty. */
  quantile(q: number): number | null {
    if (this.total === 0) return null;
    const rank = Math.ceil(q * this.total);
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i];
      if (seen >= rank) return i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i] : this.maxMs;
    }
    return this.maxMs;
  }

  snapshot(): { count: number; meanMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxMs: number; buckets: number[] } {
    return {
      count: this.total,
      meanMs: this.total ? Math.round((this.sumMs / this.total) * 100) / 100 : null,
      p50Ms: this.quantile(0.5),
      p95Ms: this.quantile(0.95),
      p99Ms: this.quantile(0.99),
      maxMs: Math.round(this.maxMs * 100) / 100,
      buckets: [...this.counts],
    };
  }
}

/** Sampling interval of the event-loop delay monitor. */
export const LOOP_MONITOR_RESOLUTION_MS = 20;

/**
 * Node records the time between two ticks of its sampling timer, so every
 * value includes the sampling interval itself (an idle loop reads ~21 ms).
 * The delay is what exceeds the interval: an idle loop reads ~1 ms.
 */
export function loopDelayFromHistogram(
  h: Pick<IntervalHistogram, 'percentile' | 'max'>,
  resolutionMs = LOOP_MONITOR_RESOLUTION_MS,
): { p50Ms: number; p99Ms: number; maxMs: number } {
  const ms = (ns: number) => Math.max(0, Math.round(ns / 1e4) / 100 - resolutionMs);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { p50Ms: round(ms(h.percentile(50))), p99Ms: round(ms(h.percentile(99))), maxMs: round(ms(h.max)) };
}

/** Every counter the relay keeps. A fixed list: a typo fails to compile. */
export const COUNTERS = [
  'auth.ok', 'auth.fail', 'auth.localChallenge', 'auth.localVerify', 'auth.localRevoked',
  'conn.opened', 'conn.closed', 'conn.stalledClosed', 'conn.pongTimeout',
  'pulse.frames.in', 'pulse.bytes.in', 'pulse.frames.out', 'pulse.bytes.out',
  'pulse.forwarded', 'pulse.deliveredToHead',
  'push.attempted', 'push.sent', 'push.failed', 'push.gone', 'push.threw', 'push.authError',
  'api.requests', 'api.errors',
] as const;
export type CounterName = typeof COUNTERS[number];

export class RelayMetrics {
  readonly startedAt = Date.now();
  private readonly counters = new Map<CounterName, number>(COUNTERS.map((name) => [name, 0]));
  /** Time the relay spends handling one inbound pulse frame (decode, route,
   *  hand to the destination socket): the relay's own share of message latency. */
  readonly frameHandling = new LatencyHistogram();
  /** Auth backend calls (account service round trips, or local) by step. */
  readonly authStages = {
    challenge: new LatencyHistogram(),
    verify: new LatencyHistogram(),
    token: new LatencyHistogram(),
    /** First `auth` frame → `auth_ok` sent (includes the client's signing). */
    total: new LatencyHistogram(),
  };
  /** Account API requests served here (account service only), start to response end. */
  readonly accountApi = new LatencyHistogram();
  /** Auth failures by error code (`invalid_token`, `wrong_region`, …). */
  readonly authFailures = new Map<string, number>();
  private loopDelay: IntervalHistogram | null = null;
  lastHealthAt: number | null = null;

  inc(name: CounterName, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  get(name: CounterName): number {
    return this.counters.get(name) ?? 0;
  }

  authFailed(code: string): void {
    this.inc('auth.fail');
    this.authFailures.set(code, (this.authFailures.get(code) ?? 0) + 1);
  }

  /** Start sampling event-loop delay (call once; cheap, 20 ms resolution). */
  startLoopMonitor(): void {
    if (this.loopDelay) return;
    this.loopDelay = monitorEventLoopDelay({ resolution: LOOP_MONITOR_RESOLUTION_MS });
    this.loopDelay.enable();
  }

  stopLoopMonitor(): void {
    this.loopDelay?.disable();
    this.loopDelay = null;
  }

  /** Event-loop delay since the previous call (then reset), in ms. */
  takeLoopDelay(): { p50Ms: number; p99Ms: number; maxMs: number } | null {
    const h = this.loopDelay;
    if (!h || h.count === 0) return null;
    const out = loopDelayFromHistogram(h);
    h.reset();
    return out;
  }

  snapshot(): Record<string, unknown> {
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries(this.counters),
      authFailures: Object.fromEntries(this.authFailures),
      frameHandling: this.frameHandling.snapshot(),
      authStages: Object.fromEntries(Object.entries(this.authStages).map(([k, h]) => [k, h.snapshot()])),
      accountApi: this.accountApi.snapshot(),
      lastHealthAgoSec: this.lastHealthAt === null ? null : Math.floor((Date.now() - this.lastHealthAt) / 1000),
    };
  }
}

/** The relay process's metrics (one per process, like the logger). */
let current = new RelayMetrics();
export function metrics(): RelayMetrics { return current; }
/** Tests only: a fresh set of counters. */
export function resetMetricsForTests(): RelayMetrics { current.stopLoopMonitor(); current = new RelayMetrics(); return current; }
