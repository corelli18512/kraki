/**
 * Windows fixes from the release review (C1, C2, C4, C6, C7, C9, C10).
 * Each test reproduces the Windows trigger with injected platform/runners.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeSdkExecutable, shimTarget } from '../cli-launch.js';
import { linkIntoShadow } from '../adapters/claude.js';
import { hydrateLoginShellEnv } from '../shell-env.js';
import { parseRegPath, refreshPathOnWindows } from '../checks.js';
import { launchedFromExplorer } from '../windows-console.js';
import { renameWithRetry } from '../fs-retry.js';
import { killProcessTree } from '../process-tree.js';

const NPM_JS_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;
const NPM_EXE_SHIM = `@ECHO off
"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'kraki-cgroup-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('C1: npm-installed Claude Code on Windows', () => {
  it('hands the SDK the script or exe behind claude.cmd, never the .cmd', () => {
    expect(shimTarget(NPM_JS_SHIM)).toBe('node_modules\\@anthropic-ai\\claude-code\\cli.js');
    expect(shimTarget(NPM_EXE_SHIM)).toBe('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
    const js = claudeSdkExecutable('C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd', 'win32', () => NPM_JS_SHIM)!;
    expect(js.endsWith('.js')).toBe(true);
    expect(js).toContain('claude-code');
    const exe = claudeSdkExecutable('C:\\npm\\claude.cmd', 'win32', () => NPM_EXE_SHIM)!;
    expect(exe.endsWith('claude.exe')).toBe(true);
  });

  it('leaves native installs and other platforms alone', () => {
    expect(claudeSdkExecutable('C:\\Users\\a\\.local\\bin\\claude.exe', 'win32')).toBe('C:\\Users\\a\\.local\\bin\\claude.exe');
    expect(claudeSdkExecutable('/opt/homebrew/bin/claude', 'darwin')).toBe('/opt/homebrew/bin/claude');
    expect(claudeSdkExecutable(undefined, 'win32')).toBeUndefined();
  });
});

describe('C2: shadow Claude home without symlink rights', () => {
  it('Windows: files become hard links that share content, directories junctions', () => {
    const d = tmp();
    const real = join(d, 'real'); mkdirSync(join(real, 'plugins'), { recursive: true });
    writeFileSync(join(real, '.credentials.json'), '{"token":"a"}');
    const shadow = join(d, 'shadow'); mkdirSync(shadow);
    expect(linkIntoShadow(join(real, '.credentials.json'), join(shadow, '.credentials.json'), 'win32')).toBe(true);
    expect(linkIntoShadow(join(real, 'plugins'), join(shadow, 'plugins'), 'win32')).toBe(true);
    // Hard link: same file, not a symlink (which needs admin on Windows).
    expect(lstatSync(join(shadow, '.credentials.json')).isSymbolicLink()).toBe(false);
    writeFileSync(join(real, '.credentials.json'), '{"token":"b"}');
    expect(readFileSync(join(shadow, '.credentials.json'), 'utf8')).toBe('{"token":"b"}');
    expect(existsSync(join(shadow, 'plugins'))).toBe(true);
  });

  it('reports failure instead of swallowing it', () => {
    const d = tmp();
    expect(linkIntoShadow(join(d, 'missing'), join(d, 'out'), 'win32')).toBe(false);
  });
});

describe('C6: no POSIX shell PATH merge on Windows', () => {
  it('leaves a Windows PATH untouched', () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\system32;C:\\Users\\a\\AppData\\Roaming\\npm' };
    let ran = false;
    const result = hydrateLoginShellEnv(env, { os: 'win32', run: (() => { ran = true; return {}; }) as never });
    expect(env.PATH).toBe('C:\\Windows\\system32;C:\\Users\\a\\AppData\\Roaming\\npm');
    expect(ran).toBe(false);
    expect(result.source).toBe('fallback');
  });
});

describe('C7: "Check again" sees agents installed in another window', () => {
  const regOut = (value: string, kind = 'REG_EXPAND_SZ') =>
    `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ${kind}    ${value}\r\n\r\n`;

  it('parses reg output and expands %VARS%', () => {
    expect(parseRegPath(regOut('%USERPROFILE%\\AppData\\Roaming\\npm;C:\\tools'), { USERPROFILE: 'C:\\Users\\a' }))
      .toBe('C:\\Users\\a\\AppData\\Roaming\\npm;C:\\tools');
    expect(parseRegPath(regOut('C:\\Windows', 'REG_SZ'))).toBe('C:\\Windows');
  });

  it('adds new registry entries and keeps the current PATH', () => {
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) if (k.toLowerCase() === 'path') delete process.env[k];
      process.env.Path = 'C:\\Windows;C:\\kraki';
      refreshPathOnWindows((cmd) => (cmd.includes('HKCU')
        ? regOut('C:\\Users\\a\\AppData\\Roaming\\npm')
        : regOut('C:\\Windows;C:\\Windows\\System32')), 'win32');
      expect(process.env.Path!.split(';')).toEqual(['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Users\\a\\AppData\\Roaming\\npm', 'C:\\kraki']);
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('C9: no "Press any key" when run from a terminal', () => {
  it('pauses only when Explorer started kraki.exe', () => {
    expect(launchedFromExplorer({ PROMPT: '$P$G' }, 1, () => 'explorer.exe')).toBe(false);
    expect(launchedFromExplorer({ WT_SESSION: 'x' }, 1, () => 'explorer.exe')).toBe(false);
    expect(launchedFromExplorer({}, 1, () => 'powershell.exe')).toBe(false);
    expect(launchedFromExplorer({}, 1, () => 'Explorer.EXE')).toBe(true);
  });
});

describe('C10: replace-by-rename survives a briefly locked file', () => {
  it('retries EPERM/EBUSY, gives up on other errors', () => {
    let calls = 0;
    renameWithRetry('a', 'b', (() => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    }) as never);
    expect(calls).toBe(3);
    expect(() => renameWithRetry('a', 'b', (() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }) as never)).toThrow('x');
    let busy = 0;
    expect(() => renameWithRetry('a', 'b', (() => { busy++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }) as never)).toThrow('busy');
    expect(busy).toBe(4);
  });
});

describe('C4: stopping on Windows ends the agents too', () => {
  it('uses taskkill /T for the whole tree', () => {
    const calls: unknown[][] = [];
    killProcessTree(4242, 'SIGTERM', 'win32', ((...a: unknown[]) => { calls.push(a); return {}; }) as never);
    expect(calls[0][0]).toBe('taskkill');
    expect(calls[0][1]).toEqual(['/PID', '4242', '/T', '/F']);
  });
});
