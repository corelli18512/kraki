import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readTrustPolicy, TrustStore } from '../trust-store.js';

const recoveryRace = vi.hoisted(() => ({ path: '', replacement: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = fs.readFileSync(...args);
      if (args[0] === recoveryRace.path) {
        // A different waiter acquires recovery after the stale read, before
        // this waiter unlinks it. The replacement belongs to a live process.
        fs.unlinkSync(recoveryRace.path);
        fs.writeFileSync(recoveryRace.path, recoveryRace.replacement, { flag: 'wx', mode: 0o600 });
        recoveryRace.path = '';
      }
      return result;
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kraki-trust-lock-'));
});
afterEach(() => {
  recoveryRace.path = '';
  recoveryRace.replacement = '';
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('trust-store lock races (#508)', () => {
  // Expected failures document an unfixed concurrency bug, not an accepted
  // behavior. Remove `.fails` when implementing design/trust-store-locks.md.
  it.fails.each(['policy', 'devices'] as const)('does not steal an initializing live %s lock', (name) => {
    const store = new TrustStore(dir);
    const lock = join(dir, `${name}.lock`);
    // This live writer has completed O_EXCL creation but not write(token).
    // writeFileSync(path, token, { flag: 'wx' }) has exactly this window.
    const fd = openSync(lock, 'wx', 0o600);
    try {
      const mutate = name === 'policy'
        ? () => store.setPolicy({ enforce: true })
        : () => store.remove('dev_not_present');
      expect(mutate).toThrow(/locked by another process/);
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(lock, 'utf8')).toBe('');
      expect(readTrustPolicy(dir)).toEqual({ enforce: false, revision: 0 });
    } finally {
      closeSync(fd);
    }
  });

  it.fails('does not unlink a successor recovery lock after a stale owner read', () => {
    const store = new TrustStore(dir);
    const lock = join(dir, 'policy.lock');
    const recover = `${lock}.recover`;
    const liveToken = `${process.pid}.successor`;
    // The main lock is live, so this waiter may only clean stale recovery.
    writeFileSync(lock, `${process.pid}.holder`, { mode: 0o600 });
    writeFileSync(recover, '999999999.dead', { mode: 0o600 });
    recoveryRace.path = recover;
    recoveryRace.replacement = liveToken;
    // No real five-second sleep: expire after the first cleanup attempt.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(5_001);
    expect(() => store.setPolicy({ enforce: true })).toThrow(/locked by another process/);
    expect(existsSync(recover)).toBe(true);
    expect(readFileSync(recover, 'utf8')).toBe(liveToken);
    expect(readTrustPolicy(dir)).toEqual({ enforce: false, revision: 0 });
  });
});
