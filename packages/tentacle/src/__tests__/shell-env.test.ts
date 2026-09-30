import { describe, it, expect, vi } from 'vitest';
import type { spawnSync } from 'node:child_process';
import { hydrateLoginShellEnv, mergePath, parseMarkedEnv } from '../shell-env.js';

const START = '__KRAKI_ENV_START__';
const END = '__KRAKI_ENV_END__';

function fakeRun(stdout: string, extra: Partial<ReturnType<typeof spawnSync>> = {}) {
  return vi.fn(() => ({ stdout, stderr: '', status: 0, signal: null, pid: 1, output: [], ...extra })) as unknown as typeof spawnSync;
}

describe('parseMarkedEnv', () => {
  it('ignores profile noise around the markers and parses NUL-separated entries', () => {
    const out = `Welcome to oh-my-zsh!\n${START}PATH=/opt/homebrew/bin:/usr/bin\0HTTPS_PROXY=http://p:8080\0MULTI=a\nb\0${END}bye`;
    expect(parseMarkedEnv(out)).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HTTPS_PROXY: 'http://p:8080',
      MULTI: 'a\nb',
    });
  });

  it('returns null when the shell never printed the markers', () => {
    expect(parseMarkedEnv('zsh: command not found')).toBeNull();
  });
});

describe('mergePath', () => {
  it('keeps first-seen order and drops duplicates and empties', () => {
    expect(mergePath('/a:/b', ':/b:/c', undefined, '/a')).toBe('/a:/b:/c');
  });
});

describe('hydrateLoginShellEnv', () => {
  it('puts the shell PATH first and adds only missing, non-shell variables', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/Users/u', PATH: '/usr/bin:/bin', SHELL: '/bin/sh', KRAKI_HOME: '/Users/u/.kraki' };
    const run = fakeRun(`${START}PATH=/Users/u/.nvm/bin:/usr/bin\0ANTHROPIC_BASE_URL=https://x\0PWD=/tmp\0KRAKI_HOME=/evil\0HOME=/nope\0${END}`);

    const result = hydrateLoginShellEnv(env, { run });

    expect(result.source).toBe('shell');
    expect(env.PATH!.split(':').slice(0, 3)).toEqual(['/Users/u/.nvm/bin', '/usr/bin', '/bin']);
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://x');
    expect(env.PWD).toBeUndefined();
    expect(env.KRAKI_HOME).toBe('/Users/u/.kraki');
    expect(env.HOME).toBe('/Users/u');
    // Interactive login shell with stdin closed so profile prompts cannot block.
    const [shell, args, opts] = (run as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shell).toBe('/bin/sh');
    expect(args.slice(0, 3)).toEqual(['-i', '-l', '-c']);
    expect(opts.stdio[0]).toBe('ignore');
  });

  it('falls back to well-known tool directories when the shell times out', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/Users/u', PATH: '/usr/bin:/bin', SHELL: '/bin/sh' };
    const run = fakeRun('', { error: Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), { code: 'ETIMEDOUT' }) });

    const result = hydrateLoginShellEnv(env, { run });

    expect(result.source).toBe('fallback');
    expect(result.error).toContain('ETIMEDOUT');
    expect(env.PATH).toContain('/Users/u/.local/bin');
    expect(env.PATH).toContain('/opt/homebrew/bin');
  });
});
