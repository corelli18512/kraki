import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restartDelayMs, isCleanExit, runSupervisor } from '../daemon-supervisor.js';

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
});
