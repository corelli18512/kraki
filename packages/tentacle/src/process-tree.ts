import { spawnSync } from 'node:child_process';

/**
 * Stop a process and everything it started. On Windows there is no signal a
 * process can catch; `process.kill` terminates only that one process and its
 * children (agents, npm's cmd.exe wrappers) keep running. `taskkill /T` ends
 * the whole tree. Elsewhere, signal the process (it cleans up its children).
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  os: NodeJS.Platform = process.platform,
  run?: typeof spawnSync,
): void {
  if (os === 'win32') {
    (run ?? spawnSync)('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  process.kill(pid, signal);
}
