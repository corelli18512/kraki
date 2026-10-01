import { describe, it, expect, vi, afterEach } from 'vitest';
import chalk from 'chalk';
import data from '../banner-data.json' with { type: 'json' };
import { printStaticBanner, printAnimatedBanner } from '../banner.js';

const tty = process.stdout.isTTY;
const level = chalk.level;
afterEach(() => {
  (process.stdout as { isTTY?: boolean }).isTTY = tty;
  chalk.level = level;
  vi.restoreAllMocks();
});

describe('banner', () => {
  it('ships the current logo as two-pixel cells', () => {
    expect(data.w).toBeGreaterThan(20);
    expect(data.cells).toHaveLength(data.h);
    for (const row of data.cells) {
      expect(row).toHaveLength(data.w);
      for (const c of row) expect(c).toHaveLength(2);
    }
  });

  it('prints text only without a TTY (pipes, CI logs)', async () => {
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await printAnimatedBanner();
    printStaticBanner();
    const out = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(out).toContain('K R A K I');
    expect(out).not.toMatch(/[▀▄]/);
    expect(write).not.toHaveBeenCalled();
  });

  it('draws the logo with the wordmark beside it on a wide terminal', () => {
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    chalk.level = 3;
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printStaticBanner();
    const lines = log.mock.calls.map((c) => String(c[0] ?? ''));
    expect(lines.filter((l) => /[▀▄]/.test(l))).toHaveLength(data.h);
    expect(lines.some((l) => /[▀▄]/.test(l) && l.includes('Your coding agents'))).toBe(true);
  });

  it('puts the wordmark below the logo on a narrow terminal', () => {
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    chalk.level = 3;
    Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printStaticBanner();
    const lines = log.mock.calls.map((c) => String(c[0] ?? ''));
    expect(lines.some((l) => /[▀▄]/.test(l) && l.includes('Your coding agents'))).toBe(false);
    expect(lines.some((l) => l.includes('Your coding agents'))).toBe(true);
  });
});
