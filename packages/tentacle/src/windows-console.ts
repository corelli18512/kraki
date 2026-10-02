import { execFileSync } from 'node:child_process';

/**
 * Whether kraki.exe was started by double-clicking it (parent: explorer.exe)
 * rather than from a terminal. Terminals leave a trace in the environment
 * (cmd sets PROMPT, Windows Terminal WT_SESSION, others TERM_PROGRAM/MSYSTEM),
 * so the parent is only looked up when none is present (plain PowerShell).
 */
export function launchedFromExplorer(
  env: NodeJS.ProcessEnv,
  ppid: number,
  parentName: (pid: number) => string | undefined = windowsProcessName,
): boolean {
  if (env.PROMPT || env.WT_SESSION || env.TERM_PROGRAM || env.MSYSTEM || env.TERM) return false;
  return parentName(ppid)?.toLowerCase() === 'explorer.exe';
}

function windowsProcessName(pid: number): string | undefined {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 3000,
    });
    return out.match(/^"([^"]+)"/m)?.[1];
  } catch {
    return undefined;
  }
}
