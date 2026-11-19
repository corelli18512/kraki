/**
 * `kraki fda` reports Kraki's Full Disk Access, not the calling terminal's
 * (K-356).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockProbeFda = vi.fn();
const mockProbeFdaAsApp = vi.fn();
vi.mock('../checks.js', async () => ({
  ...await vi.importActual<typeof import('../checks.js')>('../checks.js'),
  probeFda: () => mockProbeFda(),
  probeFdaAsApp: () => mockProbeFdaAsApp(),
}));

const { cmdFda } = await import('../cli/diagnostics.js');

describe('kraki fda (K-356)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const bundleId = process.env.__CFBundleIdentifier;
  let out: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.__CFBundleIdentifier;
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    if (bundleId === undefined) delete process.env.__CFBundleIdentifier;
    else process.env.__CFBundleIdentifier = bundleId;
    vi.restoreAllMocks();
  });

  it('asks as the Kraki app, so a terminal with Full Disk Access does not report Kraki as granted', async () => {
    mockProbeFda.mockResolvedValue('granted'); // the terminal's access
    mockProbeFdaAsApp.mockResolvedValue('denied'); // Kraki's
    await cmdFda([]);
    expect(JSON.parse(out.join(''))).toEqual({ ok: true, status: 'denied' });
  });

  it('--watch turns granted once Kraki itself is allowed', async () => {
    vi.useFakeTimers();
    try {
      mockProbeFda.mockResolvedValue('denied');
      mockProbeFdaAsApp.mockResolvedValueOnce('denied').mockResolvedValue('granted');
      const done = cmdFda(['--watch']);
      await vi.advanceTimersByTimeAsync(2500);
      await done;
    } finally {
      vi.useRealTimers();
    }
    const events = out.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.at(-1)).toEqual({ ok: true, status: 'granted', done: true });
  });

  it('probes in-process when Launch Services started it as the Kraki app (no relaunch loop)', async () => {
    process.env.__CFBundleIdentifier = 'chat.kraki.cli';
    mockProbeFda.mockResolvedValue('granted');
    await cmdFda(['--json']);
    expect(mockProbeFdaAsApp).not.toHaveBeenCalled();
    expect(JSON.parse(out.join(''))).toEqual({ ok: true, status: 'granted' });
  });

  it('probes in-process for the bundle instance probeFdaAsApp starts (--in-process)', async () => {
    mockProbeFda.mockResolvedValue('denied');
    await cmdFda(['--json', '--in-process']);
    expect(mockProbeFdaAsApp).not.toHaveBeenCalled();
    expect(JSON.parse(out.join(''))).toEqual({ ok: true, status: 'denied' });
  });
});
