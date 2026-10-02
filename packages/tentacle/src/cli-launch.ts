/**
 * How to start an agent CLI with spawn() and no shell.
 *
 * On Windows, npm installs a CLI as a `.cmd` shim. Node refuses to spawn
 * `.cmd`/`.bat` files without a shell (EINVAL, since the CVE-2024-27980 fix),
 * and running through cmd.exe would need cmd-safe quoting of every argument —
 * not possible for arbitrary prompt text. So read the shim, find the script it
 * runs, and start that with node, exactly as the shim would: the `node.exe`
 * next to the shim if present, else `node` from PATH.
 *
 * Everywhere else (and for native `.exe` agents) the path is spawned as is.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { platform } from 'node:os';

export interface CliLaunch {
  command: string;
  /** Arguments to put before the CLI's own arguments. */
  prefixArgs: string[];
}

/** Script path inside an npm `.cmd` shim, e.g. `"%dp0%\node_modules\pkg\cli.js"`. */
export function shimScript(shim: string): string | undefined {
  const match = shim.match(/"%(?:~)?dp0%?\\([^"]+\.(?:js|mjs|cjs))"/i);
  return match?.[1];
}

function nodeFor(shimDir: string): string | undefined {
  const local = join(shimDir, 'node.exe');
  if (existsSync(local)) return local;
  try {
    const out = execSync('where node', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l));
  } catch {
    return undefined;
  }
}

/**
 * What an npm `.cmd` shim actually runs: a script (`cli.js`) or a native
 * `.exe` it wraps (never the `node.exe` it uses to run scripts).
 */
export function shimTarget(shim: string): string | undefined {
  const all = [...shim.matchAll(/"%(?:~)?dp0%?\\([^"]+\.(?:js|mjs|cjs|exe))"/gi)]
    .map((m) => m[1])
    .filter((p) => !/(^|\\)node\.exe$/i.test(p));
  return all.at(-1);
}

/**
 * Path for the Claude Agent SDK's `pathToClaudeCodeExecutable`. The SDK runs
 * `.js` paths with node and spawns anything else directly — without a shell,
 * so npm's `claude.cmd` fails on Windows (EINVAL). Hand it the script or exe
 * the shim wraps instead. Other platforms and native installs: unchanged.
 */
export function claudeSdkExecutable(cliPath: string | undefined, os = platform(), read = (p: string) => readFileSync(p, 'utf8')): string | undefined {
  if (!cliPath || os !== 'win32' || !/\.(?:cmd|bat)$/i.test(cliPath)) return cliPath;
  try {
    const target = shimTarget(read(cliPath));
    if (!target) return cliPath;
    return join(dirname(cliPath), ...target.split(/[\\/]/));
  } catch {
    return cliPath;
  }
}

const cache = new Map<string, CliLaunch>();

export function cliLaunch(cliPath: string, os = platform()): CliLaunch {
  if (os !== 'win32' || !/\.(?:cmd|bat)$/i.test(cliPath)) return { command: cliPath, prefixArgs: [] };
  const cached = cache.get(cliPath);
  if (cached) return cached;
  let launch: CliLaunch = { command: cliPath, prefixArgs: [] };
  try {
    const script = shimScript(readFileSync(cliPath, 'utf8'));
    const dir = dirname(cliPath);
    const entry = script ? join(dir, ...script.split(/[\\/]/)) : undefined;
    const node = entry && existsSync(entry) ? nodeFor(dir) : undefined;
    if (entry && node) launch = { command: node, prefixArgs: [entry] };
  } catch { /* unreadable shim: spawn as is and let the error surface */ }
  cache.set(cliPath, launch);
  return launch;
}

/** `spawn(command, args)` arguments for a CLI and its own args. */
export function cliSpawnArgs(cliPath: string, args: string[]): [string, string[]] {
  const { command, prefixArgs } = cliLaunch(cliPath);
  return [command, [...prefixArgs, ...args]];
}
