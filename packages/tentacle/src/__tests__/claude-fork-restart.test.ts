import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../adapters/claude.js';

type Entry = { deferredConfig?: { resume?: string; fork?: boolean } };
const entry = (a: ClaudeAdapter, id: string) => (a as unknown as { sessions: Map<string, Entry> }).sessions.get(id);

describe('Claude fork across a daemon restart', () => {
  let home: string;
  const previous = process.env.KRAKI_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kraki-claude-fork-'));
    process.env.KRAKI_HOME = home;
    const src = join(home, 'sessions', 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, '.claude-adapter.json'), JSON.stringify({ sdkSessionId: 'sdk-src-uuid', cwd: '/tmp' }));
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.KRAKI_HOME; else process.env.KRAKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it('still forks from the source when the daemon restarts before the first message', async () => {
    const before = new ClaudeAdapter();
    await before.forkSession('src', 'fork');
    expect(entry(before, 'fork')?.deferredConfig).toMatchObject({ resume: 'sdk-src-uuid', fork: true });

    const after = new ClaudeAdapter();
    await after.resumeSession('fork');
    expect(entry(after, 'fork')?.deferredConfig).toMatchObject({ resume: 'sdk-src-uuid', fork: true });
  });
});
