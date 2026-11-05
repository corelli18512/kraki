/** K-290: PiRpcProcess reports how pi ended (signal, spawn failure), so a
 *  crash is explained beyond "Pi stopped unexpectedly". */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiRpcProcess } from '../adapters/pi-rpc.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function exitOf(proc: PiRpcProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null | undefined }> {
  return new Promise((resolve) => { proc.onExit = (code, signal) => resolve({ code, signal }); });
}

describe.skipIf(process.platform === 'win32')('PiRpcProcess exit reporting', () => {
  it('passes the signal that killed pi', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-pi-rpc-exit-'));
    dirs.push(dir);
    const cli = join(dir, 'pi');
    writeFileSync(cli, "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGKILL');\n", 'utf8');
    chmodSync(cli, 0o755);
    const proc = new PiRpcProcess({ cliPath: cli });
    const exited = exitOf(proc);
    proc.start();
    expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('names the spawn failure when pi cannot be started', async () => {
    const proc = new PiRpcProcess({ cliPath: join(tmpdir(), 'kraki-no-such-dir', 'pi') });
    const exited = exitOf(proc);
    proc.start();
    await exited;
    expect(proc.crashReason()).toMatch(/ENOENT/);
  });
});
