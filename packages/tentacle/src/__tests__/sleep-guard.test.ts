import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SleepGuard, sleepInhibitCommand } from '../sleep-guard.js';

function fakeSpawn() {
  const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: () => void }> = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: () => {} });
    children.push(child);
    return child;
  });
  return { spawn, children };
}

describe('SleepGuard (release review B3)', () => {
  it('holds one assertion while any session is active and releases when all are idle', () => {
    const { spawn, children } = fakeSpawn();
    const guard = new SleepGuard({ platform: 'darwin', pid: 42, spawn: spawn as never });
    guard.hold('a');
    guard.hold('b');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-i', '-w', '42'], expect.anything());
    guard.release('a');
    expect(children[0].kill).not.toHaveBeenCalled();
    guard.release('b');
    expect(children[0].kill).toHaveBeenCalled();
    expect(guard.holding).toBe(false);
  });

  it('stops retrying when the inhibitor binary is missing', () => {
    const { spawn, children } = fakeSpawn();
    const guard = new SleepGuard({ platform: 'linux', pid: 1, spawn: spawn as never });
    guard.hold('a');
    children[0].emit('error', new Error('ENOENT'));
    guard.release('a');
    guard.hold('b');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('has a command for each desktop platform', () => {
    expect(sleepInhibitCommand('win32', 7)?.[0]).toBe('powershell.exe');
    expect(sleepInhibitCommand('win32', 7)?.[1].join(' ')).toContain('SetThreadExecutionState');
    expect(sleepInhibitCommand('linux', 7)?.[0]).toBe('systemd-inhibit');
    expect(sleepInhibitCommand('aix', 7)).toBeNull();
  });
});

describe('SleepGuard idle limit', () => {
  it('stops holding for a session that has been silent for hours', async () => {
    const { SLEEP_HOLD_IDLE_LIMIT_MS } = await import('../sleep-guard.js');
    const { spawn, children } = fakeSpawn();
    let now = 0;
    const guard = new SleepGuard({ platform: 'darwin', pid: 1, spawn: spawn as never, now: () => now });
    guard.hold('stuck');
    guard.hold('busy');
    now = SLEEP_HOLD_IDLE_LIMIT_MS - 1000;
    guard.touch('busy');
    now = SLEEP_HOLD_IDLE_LIMIT_MS + 1000;
    guard.sweep();
    expect(guard.holding).toBe(true); // 'busy' was active recently
    now = 2 * SLEEP_HOLD_IDLE_LIMIT_MS;
    guard.sweep();
    expect(children[0].kill).toHaveBeenCalled();
    expect(guard.holding).toBe(false);
  });
});
