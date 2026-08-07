import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WakeRejectedError, WakeScheduler } from '../wake-scheduler.js';

const dirs: string[] = [];

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kraki-wake-scheduler-'));
  dirs.push(dir);
  return join(dir, 'wake-triggers.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WakeScheduler', () => {
  it('persists a one-shot trigger and reloads it after a process restart', () => {
    const storePath = tempStore();
    const now = new Date('2026-08-03T00:00:00.000Z');
    const first = new WakeScheduler({ storePath, now: () => now, onWake: vi.fn() });

    const scheduled = first.schedule({
      sessionId: 'session-1',
      instruction: 'Check the permit site',
      label: 'Permit check',
      at: '2026-08-03T00:05:00.000Z',
    });

    expect(scheduled.nextRunAt).toBe('2026-08-03T00:05:00.000Z');
    expect(JSON.parse(readFileSync(storePath, 'utf8')).version).toBe(1);

    const restarted = new WakeScheduler({ storePath, now: () => now, onWake: vi.fn() });
    expect(restarted.list('session-1')).toMatchObject([
      { id: scheduled.id, instruction: 'Check the permit site', status: 'active' },
    ]);
  });

  it('fires a due one-shot exactly once and marks it completed', async () => {
    const storePath = tempStore();
    let now = new Date('2026-08-03T00:00:00.000Z');
    const onWake = vi.fn().mockResolvedValue(undefined);
    const scheduler = new WakeScheduler({ storePath, now: () => now, onWake });
    const trigger = scheduler.schedule({
      sessionId: 'session-1',
      instruction: 'Run the check',
      at: '2026-08-03T00:00:05.000Z',
    });

    now = new Date('2026-08-03T00:00:06.000Z');
    await scheduler.runDue();
    await scheduler.runDue();

    expect(onWake).toHaveBeenCalledOnce();
    expect(onWake).toHaveBeenCalledWith(expect.objectContaining({ id: trigger.id }), '2026-08-03T00:00:05.000Z');
    expect(scheduler.list()[0].status).toBe('completed');
  });

  it('computes recurring cron occurrences in the requested timezone', async () => {
    const storePath = tempStore();
    let now = new Date('2026-08-02T00:59:00.000Z');
    const onWake = vi.fn().mockResolvedValue(undefined);
    const scheduler = new WakeScheduler({ storePath, now: () => now, onWake });
    const trigger = scheduler.schedule({
      sessionId: 'session-1',
      instruction: 'Daily check',
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    });
    expect(trigger.nextRunAt).toBe('2026-08-02T01:00:00.000Z');

    now = new Date('2026-08-02T01:00:01.000Z');
    await scheduler.runDue();

    expect(onWake).toHaveBeenCalledOnce();
    expect(scheduler.list()[0]).toMatchObject({
      status: 'active',
      nextRunAt: '2026-08-03T01:00:00.000Z',
    });
  });

  it('keeps transient failures due for retry and permanently rejects ended sessions', async () => {
    const storePath = tempStore();
    let now = new Date('2026-08-03T00:00:00.000Z');
    const onWake = vi.fn()
      .mockRejectedValueOnce(new Error('relay disconnected'))
      .mockRejectedValueOnce(new WakeRejectedError('session ended'));
    const scheduler = new WakeScheduler({ storePath, now: () => now, onWake });
    const trigger = scheduler.schedule({
      sessionId: 'session-1',
      instruction: 'Run the check',
      at: '2026-08-03T00:00:05.000Z',
    });

    now = new Date('2026-08-03T00:00:06.000Z');
    await scheduler.runDue();
    expect(scheduler.list()[0]).toMatchObject({ id: trigger.id, status: 'active' });

    await scheduler.runDue();
    expect(scheduler.list()[0]).toMatchObject({
      id: trigger.id,
      status: 'failed',
      lastError: 'session ended',
    });
  });

  it('fails closed when a persisted running occurrence is recovered after restart', () => {
    const storePath = tempStore();
    const now = new Date('2026-08-03T00:00:00.000Z');
    const first = new WakeScheduler({ storePath, now: () => now, onWake: vi.fn() });
    const trigger = first.schedule({
      sessionId: 'session-1', instruction: 'Submit once', at: '2026-08-03T00:01:00Z',
    });
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.triggers[0].status = 'running';
    writeFileSync(storePath, JSON.stringify(store));

    const restarted = new WakeScheduler({ storePath, now: () => now, onWake: vi.fn() });
    expect(restarted.list()[0]).toMatchObject({
      id: trigger.id,
      status: 'failed',
      lastError: expect.stringContaining('automatic retry is disabled'),
    });
  });

  it('rejects ambiguous, local-time, invalid-zone, or past schedules', () => {
    const storePath = tempStore();
    const now = new Date('2026-08-03T00:00:00.000Z');
    const scheduler = new WakeScheduler({ storePath, now: () => now, onWake: vi.fn() });

    expect(() => scheduler.schedule({
      sessionId: 's', instruction: 'x', at: '2026-08-03T00:01:00Z', cron: '* * * * *',
    })).toThrow('exactly one');
    expect(() => scheduler.schedule({
      sessionId: 's', instruction: 'x', at: '2026-08-03T00:01:00',
    })).toThrow('explicit UTC offset');
    expect(() => scheduler.schedule({
      sessionId: 's', instruction: 'x', cron: '* * * * *',
    })).toThrow('timezone is required');
    expect(() => scheduler.schedule({
      sessionId: 's', instruction: 'x', cron: '* * * * *', timezone: 'Mars/Olympus',
    })).toThrow('valid IANA timezone');
    expect(() => scheduler.schedule({
      sessionId: 's', instruction: 'x', at: '2026-08-02T00:00:00Z',
    })).toThrow('future');
    expect(() => scheduler.schedule({
      sessionId: ' ', instruction: 'x', at: '2026-08-03T00:01:00Z',
    })).toThrow('sessionId');
  });
});
