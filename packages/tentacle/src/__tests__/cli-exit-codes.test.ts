/**
 * Exit codes of CLI failures that print a message and carry on (K-267):
 * scripts and the apps must see a non-zero status.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('moveKrakiHomeAside', () => {
  it('sets a non-zero exit code when the Kraki folder cannot be moved (K-267)', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod does not block the rename
    const originalHome = process.env.KRAKI_HOME;
    const parent = mkdtempSync(join(tmpdir(), 'kraki-delete-ro-'));
    const home = join(parent, 'kraki');
    mkdirSync(home);
    chmodSync(parent, 0o555);
    process.env.KRAKI_HOME = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { moveKrakiHomeAside } = await import('../cli/lifecycle.js');
      moveKrakiHomeAside();
      expect(existsSync(home)).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally {
      chmodSync(parent, 0o755);
      rmSync(parent, { recursive: true, force: true });
      process.env.KRAKI_HOME = originalHome;
    }
  });
});
