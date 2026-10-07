import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceUpdateInfo } from '@kraki/protocol';
import {
  RemoteUpdater, remoteUpdateBlock, stageUpdate, takeUnannouncedResult, writeResult,
  type StageDeps, type UpdateProgress,
} from '../remote-update.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kraki-ru-'));
  process.env.KRAKI_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KRAKI_HOME;
});

describe('remoteUpdateBlock', () => {
  it('never replaces the kraki.exe built into Kraki for Windows', () => {
    expect(remoteUpdateBlock({ method: 'windows-app', target: 'C:\\K\\resources\\kraki\\kraki.exe' }, null, () => true)).toBe('unsupported');
  });

  const ok = () => true;
  it('allows a writable install', () => {
    expect(remoteUpdateBlock({ method: 'binary', target: '/x/kraki' }, null, ok)).toBeNull();
  });
  it('respects the local switch', () => {
    expect(remoteUpdateBlock({ method: 'binary', target: '/x/kraki' }, { remoteUpdate: false }, ok)).toBe('disabled');
  });
  it('unknown installs are unsupported', () => {
    expect(remoteUpdateBlock({ method: 'unknown' }, null, ok)).toBe('unsupported');
  });
  it('a root-owned npm prefix is not writable', () => {
    expect(remoteUpdateBlock({ method: 'npm', target: '/usr/lib/node_modules/@kraki/tentacle' }, null, (p) => !p.startsWith('/usr'))).toBe('not_writable');
  });
});

function fakeDeps(files: Record<string, string>, sums: string): StageDeps & { runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    download: async (url, dest, onProgress) => {
      const name = url.split('/').pop() as string;
      writeFileSync(dest, files[name] ?? 'missing');
      onProgress(5, 10); onProgress(10, 10);
    },
    fetchText: async () => sums,
    hashFile: (p) => `sha-${readFileSync(p, 'utf8')}`,
    parseChecksum: (s, asset) => s.split('\n').find((l) => l.endsWith(` ${asset}`))?.split(' ')[0] ?? null,
    run: (cmd, args) => { runs.push([cmd, ...args]); return { code: 0, out: '' }; },
  };
}

const stageBase = {
  latestTentacle: '0.36.0', currentVersion: '0.35.12', requestId: 'r1',
  platformAsset: 'kraki-cli-linux-x64', appBundleAsset: 'kraki-macos-arm64.app.tar.gz',
};

describe('stageUpdate', () => {
  it('binary: verified download staged next to the install', async () => {
    const bin = join(home, 'kraki');
    writeFileSync(bin, 'old');
    const d = fakeDeps({ 'kraki-cli-linux-x64': 'NEW' }, 'sha-NEW kraki-cli-linux-x64');
    const progress: number[] = [];
    const plan = await stageUpdate({ ...stageBase, install: { method: 'binary', target: bin } }, (f) => progress.push(f), d);
    expect(plan).toMatchObject({ method: 'binary', target: bin, staged: `${bin}.new`, from: '0.35.12', to: '0.36.0', cli: [bin] });
    expect(readFileSync(`${bin}.new`, 'utf8')).toBe('NEW');
    expect(progress.at(-1)).toBe(1);
  });
  it('refuses a download whose checksum does not match', async () => {
    const bin = join(home, 'kraki');
    writeFileSync(bin, 'old');
    const d = fakeDeps({ 'kraki-cli-linux-x64': 'TAMPERED' }, 'sha-NEW kraki-cli-linux-x64');
    await expect(stageUpdate({ ...stageBase, install: { method: 'binary', target: bin } }, () => {}, d)).rejects.toThrow(/checksum/);
  });
  it('refuses a release without a checksum for the asset', async () => {
    const bin = join(home, 'kraki');
    writeFileSync(bin, 'old');
    const d = fakeDeps({ 'kraki-cli-linux-x64': 'NEW' }, '');
    await expect(stageUpdate({ ...stageBase, install: { method: 'binary', target: bin } }, () => {}, d)).rejects.toThrow(/no checksum/);
  });
  it('npm: installs into a private prefix first and checks the version', async () => {
    const target = join(home, 'g', 'node_modules', '@kraki', 'tentacle');
    mkdirSync(target, { recursive: true });
    const d = fakeDeps({}, '');
    d.run = (cmd, args) => {
      d.runs.push([cmd, ...args]);
      const prefix = args[args.indexOf('--prefix') + 1];
      const pkg = process.platform === 'win32' ? join(prefix, 'node_modules', '@kraki', 'tentacle') : join(prefix, 'lib', 'node_modules', '@kraki', 'tentacle');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@kraki/tentacle', version: '0.36.0' }));
      return { code: 0, out: '' };
    };
    const plan = await stageUpdate({ ...stageBase, install: { method: 'npm', target } }, () => {}, d);
    expect(d.runs[0]).toEqual(expect.arrayContaining(['install', '-g', '--prefix', '@kraki/tentacle@0.36.0']));
    expect(plan.staged).toContain(join('@kraki', 'tentacle'));
    expect(plan.cli[1]).toBe(join(target, 'dist', 'cli.js'));
  });
  it('mac-app: refuses an app signed by another team', async () => {
    const target = join(home, 'Kraki.app');
    mkdirSync(target);
    const d = fakeDeps({ 'Kraki.app.zip': 'ZIP' }, 'sha-ZIP Kraki.app.zip');
    d.run = (cmd, args) => {
      if (cmd === 'ditto') mkdirSync(join(args[3], 'Kraki.app'), { recursive: true });
      if (cmd === 'codesign' && args[0] === '-dv') return { code: 0, out: args[2] === target ? 'TeamIdentifier=AAA' : 'TeamIdentifier=EVIL' };
      return { code: 0, out: '' };
    };
    await expect(stageUpdate({ ...stageBase, latestApp: '0.2.70', install: { method: 'mac-app', target, appVersion: '0.2.68' } }, () => {}, d))
      .rejects.toThrow(/someone else/);
  });
});

function updater(over: Partial<DeviceUpdateInfo> = {}, running = 0) {
  const events: UpdateProgress[] = [];
  let sessions = running;
  const stage = vi.fn(async () => ({ requestId: 'r', method: 'binary' as const, target: '/x', staged: '/x.new', cli: ['/x'], from: '0.35.12', to: '0.36.0', deadlineSeconds: 1 }));
  const launch = vi.fn();
  const u = new RemoteUpdater({
    install: { method: 'binary', target: '/x' },
    currentVersion: '0.35.12',
    status: () => ({ installedVia: 'binary', current: '0.35.12', latest: '0.36.0', latestTentacle: '0.36.0', remote: true, ...over }),
    runningSessions: () => sessions,
    emit: (p) => events.push(p),
    stage, launch, idlePollMs: 5,
  });
  return { u, events, stage, launch, setRunning: (n: number) => { sessions = n; } };
}

describe('RemoteUpdater', () => {
  it('stages and hands off to the applier', async () => {
    const { u, events, launch } = updater();
    await u.request('r1');
    expect(events.map((e) => e.phase)).toEqual(['downloading', 'installing']);
    expect(launch).toHaveBeenCalledOnce();
    expect(u.inProgress).toBe(true);
  });
  it('asks first when sessions are running', async () => {
    const { u, events, stage } = updater({}, 2);
    await u.request('r1');
    expect(events).toEqual([expect.objectContaining({ phase: 'busy', runningSessions: 2 })]);
    expect(stage).not.toHaveBeenCalled();
  });
  it('now: goes ahead with running sessions', async () => {
    const { u, launch } = updater({}, 2);
    await u.request('r1', 'now');
    expect(launch).toHaveBeenCalledOnce();
  });
  it('idle: waits until no session runs', async () => {
    const { u, events, launch, setRunning } = updater({}, 1);
    const done = u.request('r1', 'idle');
    await new Promise((r) => setTimeout(r, 20));
    expect(events[0].phase).toBe('waiting_idle');
    expect(launch).not.toHaveBeenCalled();
    setRunning(0);
    await done;
    expect(launch).toHaveBeenCalledOnce();
  });
  it('refuses when switched off, up to date, or already updating', async () => {
    const off = updater({ remote: false });
    await off.u.request('a');
    expect(off.events[0]).toMatchObject({ phase: 'failed' });
    const current = updater({ latest: undefined });
    await current.u.request('b');
    expect(current.events[0].error).toMatch(/up to date/);
    const twice = updater();
    await twice.u.request('c');
    await twice.u.request('d');
    expect(twice.events.at(-1)).toMatchObject({ phase: 'failed', requestId: 'd' });
  });
  it('reports a staging failure and can try again', async () => {
    const t = updater();
    t.stage.mockRejectedValueOnce(new Error('checksum mismatch'));
    await t.u.request('r1');
    expect(t.events.at(-1)).toMatchObject({ phase: 'failed', error: 'checksum mismatch' });
    expect(t.u.inProgress).toBe(false);
  });
});

describe('result handoff', () => {
  it('is announced once', () => {
    writeResult({ phase: 'updated', from: '0.35.12', to: '0.36.0', requestId: 'r1' });
    expect(takeUnannouncedResult()).toMatchObject({ phase: 'updated', to: '0.36.0' });
    expect(takeUnannouncedResult()).toBeNull();
  });
});

describe('renameRetry', () => {
  it('retries a locked file and gives up on other errors', async () => {
    const { renameRetry } = await import('../remote-update.js');
    let calls = 0;
    const done: string[][] = [];
    await renameRetry('a', 'b', 5, 1, (x, y) => {
      if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      done.push([x, y]);
    });
    expect(calls).toBe(3);
    expect(done).toEqual([['a', 'b']]);
    await expect(renameRetry('a', 'b', 5, 1, () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); })).rejects.toThrow('gone');
    await expect(renameRetry('a', 'b', 3, 1, () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); })).rejects.toThrow('busy');
  });
});

describe('cleanup during an update', () => {
  it('keeps the backup while an applier is still working, removes it once the result is in', async () => {
    const { cleanupAfterUpdate, writeResult, workDir, updateInProgress } = await import('../remote-update.js');
    const target = join(home, 'kraki.exe');
    writeFileSync(target, 'new'); writeFileSync(`${target}.old`, 'old');
    writeFileSync(join(workDir(), 'plan.json'), '{}');
    expect(updateInProgress()).toBe(true);
    cleanupAfterUpdate(target);                       // the new daemon starting up
    expect(readFileSync(`${target}.old`, 'utf8')).toBe('old');
    writeResult({ phase: 'updated', from: '1', to: '2' });  // the applier finished
    expect(updateInProgress()).toBe(false);
    cleanupAfterUpdate(target);
    const { existsSync } = await import('node:fs');
    expect(existsSync(`${target}.old`)).toBe(false);
  });
});
