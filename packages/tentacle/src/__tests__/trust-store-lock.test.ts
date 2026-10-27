import { execFile } from 'node:child_process';
import {
  closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readTrustPolicy, TrustStore } from '../trust-store.js';

const fsHooks = vi.hoisted(() => ({
  recoveryRacePath: '',
  recoveryRaceReplacement: '',
  linkError: '',
  onRead: null as ((path: unknown) => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      fsHooks.onRead?.(args[0]);
      const result = fs.readFileSync(...args);
      if (args[0] === fsHooks.recoveryRacePath) {
        // A different waiter acquires recovery after the stale read, before
        // this waiter unlinks it. The replacement belongs to a live process.
        fs.unlinkSync(fsHooks.recoveryRacePath);
        fs.writeFileSync(fsHooks.recoveryRacePath, fsHooks.recoveryRaceReplacement, { flag: 'wx', mode: 0o600 });
        fsHooks.recoveryRacePath = '';
      }
      return result;
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      if (fsHooks.linkError) throw Object.assign(new Error('no hard links'), { code: fsHooks.linkError });
      return fs.linkSync(...args);
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kraki-trust-lock-'));
});
afterEach(() => {
  fsHooks.recoveryRacePath = '';
  fsHooks.recoveryRaceReplacement = '';
  fsHooks.linkError = '';
  fsHooks.onRead = null;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Expire the 5 s lock wait after the first attempt (no real sleep). */
function expireLockWaitAfterFirstTry(): void {
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(5_001);
}

describe('trust-store lock races (#508)', () => {
  it.each(['policy', 'devices'] as const)('does not steal an initializing live %s lock', (name) => {
    const store = new TrustStore(dir);
    const lock = join(dir, `${name}.lock`);
    // A live writer of an earlier version has completed O_EXCL creation but
    // not write(token): writeFileSync(path, token, { flag: 'wx' }) has exactly
    // this window.
    const fd = openSync(lock, 'wx', 0o600);
    try {
      expireLockWaitAfterFirstTry();
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

  it('does not unlink a successor recovery lock after a stale owner read', () => {
    const store = new TrustStore(dir);
    const lock = join(dir, 'policy.lock');
    const recover = `${lock}.recover`;
    const liveToken = `${process.pid}.successor`;
    // The main lock is live, so this waiter may only clean stale recovery.
    writeFileSync(lock, `${process.pid}.holder`, { mode: 0o600 });
    writeFileSync(recover, '999999999.dead', { mode: 0o600 });
    fsHooks.recoveryRacePath = recover;
    fsHooks.recoveryRaceReplacement = liveToken;
    expireLockWaitAfterFirstTry();
    expect(() => store.setPolicy({ enforce: true })).toThrow(/locked by another process/);
    expect(existsSync(recover)).toBe(true);
    expect(readFileSync(recover, 'utf8')).toBe(liveToken);
    expect(readTrustPolicy(dir)).toEqual({ enforce: false, revision: 0 });
  });

  it('takes over an unwritten lock abandoned long ago (an earlier version crashed while creating it)', () => {
    const store = new TrustStore(dir);
    const lock = join(dir, 'policy.lock');
    writeFileSync(lock, '', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(store.setPolicy({ enforce: true })).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(readTrustPolicy(dir)).toEqual({ enforce: true, revision: 1 });
  });

  it('clears a recovery lock whose holder died, and one whose remover died too', () => {
    const store = new TrustStore(dir);
    const lock = join(dir, 'policy.lock');
    const recover = `${lock}.recover`;
    writeFileSync(lock, '999999999.dead-holder', { mode: 0o600 });
    writeFileSync(recover, '999999998.dead-recoverer', { mode: 0o600 });
    // A process that died while removing that dead recovery lock.
    writeFileSync(`${recover}.999999998.dead-recoverer`, '999999997.dead-remover', { mode: 0o600 });
    expect(store.setPolicy({ enforce: true })).toBe(true);
    expect(readTrustPolicy(dir)).toEqual({ enforce: true, revision: 1 });
    expect(readdirSync(dir).filter((f) => f.includes('.lock'))).toEqual([]);
  });

  it('publishes the lock with its token and leaves no temporary files', () => {
    const store = new TrustStore(dir);
    const lock = join(dir, 'policy.lock');
    let seen = '';
    // setPolicy rereads policy.json while holding the lock.
    fsHooks.onRead = (path) => {
      if (path === join(dir, 'policy.json') && existsSync(lock)) seen = readFileSync(lock, 'utf8') as string;
    };
    expect(store.setPolicy({ enforce: true })).toBe(true);
    expect(seen).toMatch(new RegExp(`^${process.pid}\\.[0-9a-f-]{36}$`));
    expect(readdirSync(dir)).toEqual(['policy.json']);
  });

  it('still locks on a file system without hard links', () => {
    fsHooks.linkError = 'EPERM';
    const store = new TrustStore(dir);
    expect(store.setPolicy({ enforce: true })).toBe(true);
    writeFileSync(join(dir, 'policy.lock'), `${process.pid}.holder`, { mode: 0o600 });
    expireLockWaitAfterFirstTry();
    expect(() => store.setPolicy({ enforce: false })).toThrow(/locked by another process/);
    expect(readTrustPolicy(dir)).toEqual({ enforce: true, revision: 1 });
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('serializes policy compare-and-set across real processes', async () => {
    const mod = resolve(__dirname, '../trust-store.ts');
    const rounds = 25;
    // Each process tries `rounds` compare-and-sets from the revision it read;
    // with a lost update two of them would win from the same revision.
    const script = `import { readTrustPolicy, TrustStore } from ${JSON.stringify(mod)};
const dir = ${JSON.stringify(dir)};
const store = new TrustStore(dir);
let won = 0;
for (let i = 0; i < ${rounds}; i++) {
  if (store.setPolicy({ enforce: i % 2 === 0 }, readTrustPolicy(dir).revision)) won++;
}
process.stdout.write('\\nWON=' + won + '\\n');`;
    const run = () => new Promise<number>((ok, fail) => execFile(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: resolve(__dirname, '../..') }, (err, out) => (err ? fail(err) : ok(Number(/^WON=(\d+)$/m.exec(out)?.[1])))));
    const wins = await Promise.all([run(), run(), run(), run()]);
    const total = wins.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(readTrustPolicy(dir).revision).toBe(total);
    expect(readdirSync(dir).filter((f) => f.includes('.lock') || f.endsWith('.tmp'))).toEqual([]);
  }, 60_000);
});

describe('Windows sharing violations (#508, found on a real Windows run)', () => {
  it('retries EPERM/EACCES/EBUSY only on Windows, and gives up on other errors', async () => {
    const { __windowsSharing: w } = await import('../trust-store.js');
    const err = (code: string) => Object.assign(new Error(code), { code });
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      expect(w.isWindowsSharingError(err(code), 'win32')).toBe(true);
      expect(w.isWindowsSharingError(err(code), 'darwin')).toBe(false);
    }
    expect(w.isWindowsSharingError(err('ENOENT'), 'win32')).toBe(false);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      let calls = 0;
      expect(w.retryWindowsSharing(() => { if (++calls < 3) throw err('EPERM'); return 'ok'; })).toBe('ok');
      expect(calls).toBe(3);
      calls = 0;
      expect(() => w.retryWindowsSharing(() => { calls++; throw err('ENOENT'); })).toThrow('ENOENT');
      expect(calls).toBe(1);
      expect(() => w.retryWindowsSharing(() => { throw err('EBUSY'); }, 30)).toThrow('EBUSY');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
