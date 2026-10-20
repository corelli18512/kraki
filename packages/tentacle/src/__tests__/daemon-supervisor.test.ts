import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restartDelayMs, isCleanExit, runSupervisor, PERMANENT_EXIT_CODE, BINARY_REPLACED_EXIT_CODE, executableIdentity } from '../daemon-supervisor.js';
import { renameSync, rmSync } from 'node:fs';

describe('daemon supervisor', () => {
  it('backs off 1s, 2s, 4s … capped at 60s', () => {
    expect([1, 2, 3, 4, 7, 20].map(restartDelayMs)).toEqual([1000, 2000, 4000, 8000, 60000, 60000]);
  });

  it('only code 0 without a signal is a clean exit', () => {
    expect(isCleanExit(0, null)).toBe(true);
    expect(isCleanExit(1, null)).toBe(false);
    expect(isCleanExit(null, 'SIGKILL')).toBe(false);
    expect(isCleanExit(null, 'SIGSEGV')).toBe(false);
  });

  it('restarts a crashing worker by itself, then stops when it exits cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-sup-'));
    const counter = join(dir, 'runs');
    // Crashes twice (exit 1, then SIGKILL itself), exits cleanly the third time.
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, `
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      const f = ${JSON.stringify(counter)};
      const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) + 1 : 1;
      writeFileSync(f, String(n));
      if (!process.env.KRAKI_SUPERVISED) process.exit(9);
      if (n === 1) process.exit(1);
      if (n === 2) process.kill(process.pid, 'SIGKILL');
      process.exit(0);
    `);
    const code = await runSupervisor({ command: process.execPath, args: [worker], logFile: join(dir, 'sup.log'), delay: () => 10 });
    expect(code).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('3');
    const log = readFileSync(join(dir, 'sup.log'), 'utf8');
    expect(log).toMatch(/restarting/);
    expect(log).toMatch(/exited cleanly/);
  });

  it('records its PID while running and removes it when done', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-sup-'));
    const pidFile = join(dir, 'daemon-supervisor.pid');
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, `
      import { readFileSync } from 'node:fs';
      if (readFileSync(${JSON.stringify(pidFile)}, 'utf8') !== String(process.ppid)) process.exit(5);
      process.exit(0);
    `);
    const code = await runSupervisor({ command: process.execPath, args: [worker], logFile: join(dir, 'sup.log'), pidFile, delay: () => 10, maxStarts: 2 });
    expect(code).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('does not restart a worker that exits with the permanent code (no config)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-sup-'));
    const counter = join(dir, 'runs');
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, `
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      const f = ${JSON.stringify(counter)};
      writeFileSync(f, String(existsSync(f) ? Number(readFileSync(f, 'utf8')) + 1 : 1));
      process.exit(${PERMANENT_EXIT_CODE});
    `);
    const code = await runSupervisor({ command: process.execPath, args: [worker], logFile: join(dir, 'sup.log'), delay: () => 10, maxStarts: 5 });
    expect(code).toBe(PERMANENT_EXIT_CODE);
    expect(readFileSync(counter, 'utf8')).toBe('1');
  });

  it('forwards SIGTERM to the worker and does not restart it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-sup-'));
    const marker = join(dir, 'got-term');
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); });
      setInterval(() => {}, 1000);
    `);
    const done = runSupervisor({ command: process.execPath, args: [worker], logFile: join(dir, 'sup.log'), delay: () => 10 });
    await new Promise((r) => setTimeout(r, 400));
    process.emit('SIGTERM', 'SIGTERM');
    expect(await done).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  describe('executable watch (app update replaced the binary)', () => {
    // A worker that runs until SIGTERM, then exits cleanly.
    const longWorker = (dir: string) => {
      const worker = join(dir, 'worker.mjs');
      writeFileSync(worker, `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`);
      return worker;
    };

    it('identifies a file by inode, so a same-path replacement is detected', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kraki-sup-'));
      const bin = join(dir, 'kraki');
      writeFileSync(bin, 'old');
      const before = executableIdentity(bin);
      renameSync(bin, join(dir, 'kraki.old'));
      expect(executableIdentity(bin)).toBeNull();
      writeFileSync(bin, 'new');
      expect(executableIdentity(bin)).not.toBeNull();
      expect(executableIdentity(bin)).not.toBe(before);
    });

    it('stops the worker and exits with the replaced code when the binary is swapped', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kraki-sup-'));
      const bin = join(dir, 'kraki');
      writeFileSync(bin, 'old');
      const done = runSupervisor({
        command: process.execPath, args: [longWorker(dir)], logFile: join(dir, 'sup.log'),
        watchExecutable: bin, binaryCheckMs: 50, delay: () => 10,
      });
      await new Promise((r) => setTimeout(r, 300));
      // Sparkle-style: move the old bundle away, put the new file at the same path.
      renameSync(bin, join(dir, 'kraki.old'));
      rmSync(join(dir, 'kraki.old'));
      writeFileSync(bin, 'new');
      expect(await done).toBe(BINARY_REPLACED_EXIT_CODE);
      expect(readFileSync(join(dir, 'sup.log'), 'utf8')).toMatch(/executable replaced/);
    });

    it('exits when the binary is deleted', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kraki-sup-'));
      const bin = join(dir, 'kraki');
      writeFileSync(bin, 'old');
      const done = runSupervisor({
        command: process.execPath, args: [longWorker(dir)], logFile: join(dir, 'sup.log'),
        watchExecutable: bin, binaryCheckMs: 50, delay: () => 10,
      });
      await new Promise((r) => setTimeout(r, 300));
      rmSync(bin);
      expect(await done).toBe(BINARY_REPLACED_EXIT_CODE);
      expect(readFileSync(join(dir, 'sup.log'), 'utf8')).toMatch(/executable deleted/);
    });

    it('ignores a single mid-swap miss when the original file comes back', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kraki-sup-'));
      const bin = join(dir, 'kraki');
      writeFileSync(bin, 'old');
      const done = runSupervisor({
        command: process.execPath, args: [longWorker(dir)], logFile: join(dir, 'sup.log'),
        watchExecutable: bin, binaryCheckMs: 200, delay: () => 10,
      });
      await new Promise((r) => setTimeout(r, 250));
      renameSync(bin, join(dir, 'kraki.tmp'));
      await new Promise((r) => setTimeout(r, 200));
      renameSync(join(dir, 'kraki.tmp'), bin);
      await new Promise((r) => setTimeout(r, 600));
      process.emit('SIGTERM', 'SIGTERM');
      expect(await done).toBe(0);
      expect(readFileSync(join(dir, 'sup.log'), 'utf8')).not.toMatch(/executable (replaced|deleted)/);
    });
  });
});
