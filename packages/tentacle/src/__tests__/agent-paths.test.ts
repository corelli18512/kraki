import { describe, it, expect } from 'vitest';
import { appBundledCliCandidates, findAppBundledCli, type AppCliDeps } from '../agent-paths.js';

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
