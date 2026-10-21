/**
 * Daemon run record (log audit 2026-10-22): the 2026-10-20 01:22 daemon death
 * left no trace anywhere. The next start must say the previous run ended
 * uncleanly and when it was last seen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = async () => {
  vi.resetModules();
  return import('../run-record.js');
};

describe('daemon run record', () => {
  beforeEach(async () => {
    const { rmSync } = await import('node:fs');
    rmSync(join(process.env.KRAKI_HOME!, 'daemon-run.json'), { force: true });
  });

  it('reports a first run, a clean exit, an update and an unclean exit', async () => {
    let rr = await load();
    expect(rr.beginRun('1.0.0', Date.parse('2026-10-16T15:21:50Z')).startReason).toBe('first-run');
    rr.touchRun(Date.parse('2026-10-19T17:22:30Z'));
    // Killed: endRun never runs.

    rr = await load();
    const afterKill = rr.beginRun('1.0.0', Date.parse('2026-10-19T17:26:41Z'));
    expect(afterKill.startReason).toBe('after-unclean-exit');
    expect(afterKill.previousUnclean).toBe(true);
    expect(afterKill.previous).toMatchObject({ version: '1.0.0', lastSeenAt: '2026-10-19T17:22:30.000Z' });
    expect(afterKill.previous?.endedAt).toBeUndefined();
    rr.endRun('SIGTERM', Date.parse('2026-10-20T23:26:11Z'));

    rr = await load();
    const afterUpdate = rr.beginRun('1.1.0', Date.parse('2026-10-20T23:26:13Z'));
    expect(afterUpdate.startReason).toBe('after-update');
    expect(afterUpdate.previous).toMatchObject({ exitReason: 'SIGTERM', endedAt: '2026-10-20T23:26:11.000Z' });
    rr.endRun('SIGTERM');

    rr = await load();
    expect(rr.beginRun('1.1.0').startReason).toBe('after-clean-exit');
  });

  it('keeps the last observed Full Disk Access state for the next start', async () => {
    let rr = await load();
    rr.beginRun('1.0.0');
    rr.noteRunFda('denied');
    rr.endRun('SIGTERM');
    rr = await load();
    expect(rr.beginRun('1.0.0').previous?.fda).toBe('denied');
    const onDisk = JSON.parse(readFileSync(join(process.env.KRAKI_HOME!, 'daemon-run.json'), 'utf8'));
    expect(onDisk.endedAt).toBeUndefined();
  });
});
