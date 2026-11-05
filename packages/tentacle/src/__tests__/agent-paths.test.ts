import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appBundledCliCandidates, findAppBundledCli, isExecutableFile, type AppCliDeps } from '../agent-paths.js';

function deps(files: string[], dirs: Record<string, string[]> = {}, os = 'darwin'): AppCliDeps {
  return { os, home: '/Users/u', isExecutable: (p) => files.includes(p), listDir: (p) => dirs[p] ?? [] };
}

describe('agent CLIs inside desktop apps', () => {
  it('finds codex inside the Codex app (ChatGPT.app or Codex.app, /Applications or ~/Applications)', () => {
    const p = '/Users/u/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex';
    expect(findAppBundledCli('codex', deps([p]))).toBe(p);
    const q = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
    expect(findAppBundledCli('codex', deps([p, q]))).toBe(q);
  });

  it('K-287: also finds the codex binary at Contents/Resources/codex (layout the usage check used)', () => {
    const p = '/Applications/Codex.app/Contents/Resources/codex';
    expect(findAppBundledCli('codex', deps([p]))).toBe(p);
  });

  it.runIf(process.platform !== 'win32')('K-287: a Contents/Resources/codex directory is not taken for the CLI', () => {
    const home = mkdtempSync(join(tmpdir(), 'kraki-agent-paths-'));
    try {
      const real: AppCliDeps = { os: 'darwin', home, isExecutable: (p) => p.startsWith(home) && isExecutableFile(p), listDir: () => [] };
      const dir = join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex');
      mkdirSync(dir, { recursive: true }); // directories carry the X bit too
      expect(findAppBundledCli('codex', real)).toBeUndefined();
      const bin = join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex');
      mkdirSync(join(bin, '..'), { recursive: true });
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
      expect(findAppBundledCli('codex', real)).toBe(bin);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('picks the newest Claude Code the Claude desktop app downloaded', () => {
    const root = '/Users/u/Library/Application Support/Claude/claude-code';
    const bin = (v: string) => `${root}/${v}/claude.app/Contents/MacOS/claude`;
    const d = deps([bin('2.1.9'), bin('2.1.10')], { [root]: ['2.1.9', '2.1.10', '.tmp'] });
    expect(findAppBundledCli('claude', d)).toBe(bin('2.1.10'));
  });

  it('has nothing for other agents or other platforms', () => {
    expect(appBundledCliCandidates('pi', deps([]))).toEqual([]);
    expect(appBundledCliCandidates('codex', deps([], {}, 'linux'))).toEqual([]);
  });
});
