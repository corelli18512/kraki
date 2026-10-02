import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pidFileIsFromBeforeBoot } from '../login-start.js';

describe('kraki start --login', () => {
  it('treats a daemon.pid written before the last boot as stale', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'kraki-login-')), 'daemon.pid');
    writeFileSync(f, '4316');
    const now = Date.now();
    utimesSync(f, new Date(now - 3_600_000), new Date(now - 3_600_000)); // written an hour ago
    expect(pidFileIsFromBeforeBoot(f, now, 120)).toBe(true);    // booted 2 min ago
    expect(pidFileIsFromBeforeBoot(f, now, 7_200)).toBe(false); // booted 2 h ago
    expect(pidFileIsFromBeforeBoot(join(f, 'missing'), now, 120)).toBe(false);
  });
});
