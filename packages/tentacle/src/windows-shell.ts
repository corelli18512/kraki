/**
 * Pi runs every command through bash. On Windows that means Git Bash (or
 * another bash) must exist — a clean Windows has none, and Pi then cannot run
 * a single command (seen in a clean Windows 11 VM: Kraki's setup said "Pi
 * ready", the first task failed to run anything). Mirrors Pi's own lookup
 * (dist/utils/shell.js): settings shellPath, Git Bash in Program Files, then
 * bash.exe on PATH.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GIT_FOR_WINDOWS_URL = 'https://git-scm.com/download/win';

export interface ShellProbeDeps {
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  piSettings: () => string | undefined;
  whereBash: () => string[];
}

const realDeps: ShellProbeDeps = {
  env: process.env,
  exists: existsSync,
  piSettings: () => {
    const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
    try { return readFileSync(join(dir, 'settings.json'), 'utf8'); } catch { return undefined; }
  },
  whereBash: () => {
    try {
      return execFileSync('where', ['bash.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 })
        .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } catch { return []; }
  },
};

/** True when Pi will find a shell on this Windows machine. */
export function piHasShellOnWindows(deps: ShellProbeDeps = realDeps): boolean {
  try {
    const custom = JSON.parse(deps.piSettings() ?? '{}').shellPath;
    if (typeof custom === 'string' && custom && deps.exists(custom)) return true;
  } catch { /* unreadable settings: Pi ignores them too */ }
  for (const base of [deps.env.ProgramFiles, deps.env['ProgramFiles(x86)']]) {
    if (base && deps.exists(`${base}\\Git\\bin\\bash.exe`)) return true;
  }
  return deps.whereBash().some((p) => deps.exists(p));
}
