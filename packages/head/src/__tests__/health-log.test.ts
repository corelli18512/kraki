/**
 * Log audit 2026-10-22 (f): the 30 s health line was 93–99 % of all relay log
 * lines, carried no account API numbers (always conns 0 on the account
 * service) and its event-loop delay included the 20 ms sampling interval.
 */
import { describe, it, expect } from 'vitest';
import { HealthLog, HEALTH_LOG_IDLE_EVERY_MS, type HealthSample } from '../health-log.js';
import { loopDelayFromHistogram } from '../metrics.js';

const idle: HealthSample = { conns: 2, endpoints: 3, durableRows: 0, rssMb: 90, heapUsedMb: 18, heapTotalMb: 20, evlLagMs: 1, evlMaxMs: 3 };
const noApi = { requests: 0, errors: 0 };

describe('HealthLog', () => {
  it('logs an unchanged relay every 5 minutes, not every 30 s', () => {
    let now = 0;
    const log = new HealthLog(() => now);
    let lines = 0;
    for (; now < 30 * 60_000; now += 30_000) if (log.next(idle, noApi, now / 1000)) lines++;
    expect(lines).toBe(30 * 60_000 / HEALTH_LOG_IDLE_EVERY_MS);
  });

  it('logs right away on a connection change, a stall or an RSS jump, with the largest skipped stall', () => {
    let now = 0;
    const log = new HealthLog(() => now);
    expect(log.next(idle, noApi, 0)).not.toBeNull();
    now += 30_000;
    expect(log.next({ ...idle, evlMaxMs: 60 }, noApi, 30)).toBeNull();
    now += 30_000;
    expect(log.next({ ...idle, conns: 3, evlMaxMs: 5 }, noApi, 60)).toMatchObject({ conns: 3, evlMaxMs: 60, upSec: 60 });
    now += 30_000;
    expect(log.next({ ...idle, conns: 3, evlMaxMs: 518 }, noApi, 90)).toMatchObject({ evlMaxMs: 518 });
    now += 30_000;
    expect(log.next({ ...idle, conns: 3, rssMb: 101 }, noApi, 120)).toMatchObject({ rssMb: 101 });
  });

  it('reports account API requests and errors since the previous line once any was served', () => {
    let now = 0;
    const log = new HealthLog(() => now);
    expect(log.next(idle, noApi, 0)).not.toHaveProperty('apiReq');
    now += HEALTH_LOG_IDLE_EVERY_MS;
    expect(log.next(idle, { requests: 7, errors: 1 }, 300)).toMatchObject({ apiReq: 7, apiErr: 1 });
    now += HEALTH_LOG_IDLE_EVERY_MS;
    expect(log.next(idle, { requests: 9, errors: 1 }, 600)).toMatchObject({ apiReq: 2, apiErr: 0 });
  });
});

describe('loopDelayFromHistogram', () => {
  it('excludes the sampling interval from the reported delay', () => {
    const ms = (n: number) => n * 1e6;
    const h = { percentile: (p: number) => (p === 50 ? ms(20.4) : ms(21.22)), max: ms(537.92) };
    expect(loopDelayFromHistogram(h, 20)).toEqual({ p50Ms: 0.4, p99Ms: 1.22, maxMs: 517.92 });
    expect(loopDelayFromHistogram({ percentile: () => ms(19.6), max: ms(19.8) }, 20)).toEqual({ p50Ms: 0, p99Ms: 0, maxMs: 0 });
  });
});
