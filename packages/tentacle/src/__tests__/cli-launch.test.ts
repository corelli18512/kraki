import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliLaunch, shimScript } from '../cli-launch.js';

// The npm 10 shim for `npm i -g @earendil-works/pi-coding-agent` (abridged).
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
].join('\r\n');

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('cliLaunch', () => {
  it('finds the script an npm .cmd shim runs', () => {
    expect(shimScript(NPM_SHIM)).toBe('node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js');
    expect(shimScript('@echo off\r\n"%~dp0\\pi.exe" %*')).toBeUndefined();
  });

  it('runs an npm .cmd shim as node + script on Windows (spawn cannot run .cmd)', () => {
    dir = mkdtempSync(join(tmpdir(), 'kraki-shim-'));
    const script = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle');
    mkdirSync(script, { recursive: true });
    writeFileSync(join(script, 'cli.js'), '');
    writeFileSync(join(dir, 'node.exe'), '');
    writeFileSync(join(dir, 'pi.cmd'), NPM_SHIM);
    const launch = cliLaunch(join(dir, 'pi.cmd'), 'win32');
    expect(launch.command).toBe(join(dir, 'node.exe'));
    expect(launch.prefixArgs).toEqual([join(script, 'cli.js')]);
  });

  it('spawns everything else as is', () => {
    expect(cliLaunch('/usr/local/bin/pi', 'darwin')).toEqual({ command: '/usr/local/bin/pi', prefixArgs: [] });
    expect(cliLaunch('C:\\Tools\\pi.exe', 'win32')).toEqual({ command: 'C:\\Tools\\pi.exe', prefixArgs: [] });
  });
});
