import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScheduleWakeTool } from '../tools/schedule-wake.js';
import { WakeScheduler } from '../../wake-scheduler.js';

const dirs: string[] = [];

function createScheduler() {
  const dir = mkdtempSync(join(tmpdir(), 'kraki-schedule-wake-tool-'));
  dirs.push(dir);
  return new WakeScheduler({
    storePath: join(dir, 'wake-triggers.json'),
    now: () => new Date('2026-08-03T00:00:00.000Z'),
    onWake: vi.fn(),
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('schedule_wake MCP tool', () => {
  it('binds the trigger to the URL-injected session context', async () => {
    const scheduler = createScheduler();
    const tool = createScheduleWakeTool(scheduler);

    const result = await tool.handler({
      sessionId: 'model-forged-session',
      instruction: 'Check the permit site',
      at: '2026-08-03T00:05:00Z',
    }, { sessionId: 'current-session' });

    expect(result.isError).not.toBe(true);
    expect(scheduler.list()).toMatchObject([
      { sessionId: 'current-session', instruction: 'Check the permit site', status: 'active' },
    ]);
  });

  it('returns a tool error for ambiguous scheduling input', async () => {
    const scheduler = createScheduler();
    const tool = createScheduleWakeTool(scheduler);

    const result = await tool.handler({
      instruction: 'Check later',
      at: '2026-08-03T00:05:00Z',
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    }, { sessionId: 'current-session' });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('exactly one') }],
    });
    expect(scheduler.list()).toEqual([]);
  });
});
