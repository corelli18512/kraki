/**
 * Real-Windows checks for the C-group fixes (runs only on win32; CI's
 * Windows job and manual runs on a Windows PC). No mocks: real junctions,
 * hard links, registry, tasklist, taskkill and file locks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { linkIntoShadow } from '../adapters/claude.js';
import { refreshPathOnWindows } from '../checks.js';
import { launchedFromExplorer } from '../windows-console.js';
import { renameWithRetry } from '../fs-retry.js';
import { killProcessTree } from '../process-tree.js';

const win = process.platform === 'win32';
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'kraki-winreal-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const alive = (pid: number) => {
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return out.includes(`"${pid}"`);
};

describe.runIf(win)('Windows (real)', () => {
  it('C2: junction for directories, hard link for files', () => {
    const d = tmp();
    const real = join(d, 'real'); mkdirSync(join(real, 'plugins'), { recursive: true });
    writeFileSync(join(real, 'plugins', 'p.json'), '{}');
    writeFileSync(join(real, '.credentials.json'), 'one');
    const shadow = join(d, 'shadow'); mkdirSync(shadow);
    expect(linkIntoShadow(join(real, 'plugins'), join(shadow, 'plugins'))).toBe(true);
    expect(linkIntoShadow(join(real, '.credentials.json'), join(shadow, '.credentials.json'))).toBe(true);
    expect(readFileSync(join(shadow, 'plugins', 'p.json'), 'utf8')).toBe('{}');
    writeFileSync(join(real, '.credentials.json'), 'two');
    expect(readFileSync(join(shadow, '.credentials.json'), 'utf8')).toBe('two');
    expect(lstatSync(join(shadow, '.credentials.json')).isSymbolicLink()).toBe(false);
    // Re-linking an existing entry (every session start) works too.
    expect(linkIntoShadow(join(real, 'plugins'), join(shadow, 'plugins'))).toBe(true);
    expect(existsSync(join(real, 'plugins', 'p.json'))).toBe(true);
  });

  it('C7: PATH refresh from the real registry keeps the current entries', () => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path')!;
    const saved = process.env[key];
    try {
      process.env[key] = 'C:\\kraki-marker';
      refreshPathOnWindows();
      const entries = process.env[key]!.split(';');
      expect(entries).toContain('C:\\kraki-marker');
      expect(entries.some((e) => /\\Windows\\system32$/i.test(e))).toBe(true);
      expect(entries.every((e) => !e.includes('%'))).toBe(true);
    } finally {
      process.env[key] = saved;
    }
  });

  it('C9: a process started from a shell is not "double-clicked"', () => {
    expect(launchedFromExplorer({}, process.ppid)).toBe(false);
  });

  it('C10: rename waits out a file held open without sharing', async () => {
    const d = tmp();
    const target = join(d, 'meta.json');
    writeFileSync(target, 'old');
    writeFileSync(join(d, 'meta.json.tmp'), 'new');
    const ready = join(d, 'locked');
    const ps = spawn('powershell', ['-NoProfile', '-Command',
      `$f=[IO.File]::Open('${target}','Open','Read','None'); New-Item '${ready}' | Out-Null; Start-Sleep -Milliseconds 120; $f.Close()`],
      { windowsHide: true });
    while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 20));
    renameWithRetry(join(d, 'meta.json.tmp'), target, undefined, 8);
    expect(readFileSync(target, 'utf8')).toBe('new');
    await new Promise((r) => ps.once('exit', r));
  });

  it('C4: taskkill /T ends the child and its grandchild', async () => {
    // Like the daemon and its agents: a node process that started another.
    const child = spawn(process.execPath, ['-e',
      "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setInterval(()=>{},1000)"],
      { windowsHide: true, stdio: 'ignore' });
    let grand = '';
    for (let i = 0; i < 40 && !/^\d+$/.test(grand); i++) {
      await new Promise((r) => setTimeout(r, 250));
      grand = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid} and Name='node.exe'").ProcessId`], { encoding: 'utf8' }).trim();
    }
    expect(grand).toMatch(/^\d+$/);
    killProcessTree(child.pid!);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(child.pid!)).toBe(false);
    expect(alive(Number(grand))).toBe(false);
  });
});
