/** `kraki agents --json` cleans up its scratch folder (K-275). */

import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell-env.js', () => ({ hydrateLoginShellEnv: () => ({ source: 'fallback', shell: '', addedKeys: [] }) }));
vi.mock('../adapters/multi.js', () => ({ createAgentAdapter: () => { throw new Error('not used'); } }));

const { runAgentsCheckJson } = await import('../agents-check.js');

describe('runAgentsCheckJson scratch folder (K-275)', () => {
  const cwd = process.cwd();
  const originalTmp = process.env.TMPDIR;
  afterEach(() => {
    process.chdir(cwd);
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
    vi.restoreAllMocks();
  });

  it('runs the agents from a scratch folder and removes it afterwards', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kraki-agents-scratch-test-')));
    process.env.TMPDIR = root;
    let checkedIn: string | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      if (String(chunk).includes('"done"')) checkedIn = process.cwd();
      return true;
    }) as never);
    try {
      await runAgentsCheckJson(['--only', 'none']);
      expect(checkedIn?.startsWith(join(root, 'kraki-agents-'))).toBe(true);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
