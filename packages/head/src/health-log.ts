/**
 * The periodic `health` log line. Sampled every ping pass (30 s) but only
 * logged when something moved or stalled, and otherwise every 5 minutes as a
 * heartbeat: at a fixed 30 s it was 93–99 % of all relay log lines, nearly
 * all identical (log audit 2026-10-22).
 */

/** An unchanged relay logs its health line this often. */
export const HEALTH_LOG_IDLE_EVERY_MS = 5 * 60_000;
/** An event-loop stall at least this long logs the line right away. */
export const HEALTH_LOG_STALL_MS = 100;
/** So does an RSS change of at least this much since the last line. */
export const HEALTH_LOG_RSS_STEP_MB = 10;

export interface HealthSample {
  conns: number;
  endpoints: number;
  durableRows: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  /** Event-loop delay of this sample period (see RelayMetrics.takeLoopDelay). */
  evlLagMs?: number;
  evlMaxMs?: number;
}

export class HealthLog {
  private last?: { at: number; sample: HealthSample; apiRequests: number; apiErrors: number };
  /** Largest stall of the samples not logged since the last line. */
  private skippedMaxMs?: number;

  constructor(private readonly now = () => Date.now()) {}

  /** The fields to log for this sample, or null to skip it. `api`: the
   *  account API counters (reported as deltas once any request was served). */
  next(sample: HealthSample, api: { requests: number; errors: number }, upSec: number): Record<string, unknown> | null {
    const now = this.now();
    const last = this.last;
    const due = !last
      || now - last.at >= HEALTH_LOG_IDLE_EVERY_MS
      || sample.conns !== last.sample.conns
      || sample.endpoints !== last.sample.endpoints
      || sample.durableRows !== last.sample.durableRows
      || Math.abs(sample.rssMb - last.sample.rssMb) >= HEALTH_LOG_RSS_STEP_MB
      || (sample.evlMaxMs ?? 0) >= HEALTH_LOG_STALL_MS;
    if (!due) {
      if (sample.evlMaxMs !== undefined) this.skippedMaxMs = Math.max(this.skippedMaxMs ?? 0, sample.evlMaxMs);
      return null;
    }
    const evlMaxMs = this.skippedMaxMs === undefined ? sample.evlMaxMs : Math.max(this.skippedMaxMs, sample.evlMaxMs ?? 0);
    const apiRequests = api.requests - (last?.apiRequests ?? 0);
    const apiErrors = api.errors - (last?.apiErrors ?? 0);
    this.last = { at: now, sample, apiRequests: api.requests, apiErrors: api.errors };
    this.skippedMaxMs = undefined;
    return {
      ...sample,
      evlMaxMs,
      ...(api.requests > 0 && { apiReq: apiRequests, apiErr: apiErrors }),
      upSec,
    };
  }
}
