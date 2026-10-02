/**
 * On Windows, start every child process without a console window.
 *
 * Kraki's background process has no console (it is started detached). Any
 * console program it starts without `windowsHide` therefore gets a console of
 * its own — and with Windows Terminal as the default terminal (the Windows 11
 * default) that is a visible, empty terminal window on the user's desktop:
 * seen in a clean Windows 11 VM as an empty "pi" window popping up whenever a
 * Pi session started, covering the user's own terminal and swallowing what
 * they typed. Version checks (`codex --version`, `where node`, …) flash one too.
 *
 * Patching node:child_process once at startup covers our own calls and those
 * of libraries; `syncBuiltinESMExports` makes ESM named imports see it. A
 * caller that explicitly passes `windowsHide: false` keeps its choice.
 */

import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

type AnyFn = (...args: unknown[]) => unknown;
const FNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
let installed = false;

/** Add `windowsHide: true` to the options argument of a child_process call. */
export function withHiddenWindow(name: (typeof FNS)[number], args: unknown[]): unknown[] {
  const out = [...args];
  // Options position: exec/execSync(cmd, opts, cb); spawn/execFile/fork(cmd, args?, opts?, cb?).
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  let i: number;
  if (name === 'exec' || name === 'execSync') i = 1;
  else i = Array.isArray(out[1]) ? 2 : 1;
  if (isObj(out[i])) {
    if (out[i] && (out[i] as Record<string, unknown>).windowsHide === undefined) out[i] = { ...(out[i] as object), windowsHide: true };
  } else if (out[i] === undefined || typeof out[i] === 'function') {
    // No options given: insert them (keep a trailing callback in place).
    const cb = typeof out[i] === 'function' ? out[i] : undefined;
    out[i] = { windowsHide: true };
    if (cb) out[i + 1] = cb;
    // spawn(cmd, opts) form where args were omitted keeps working: position 1 is options.
  }
  return out;
}

export function hideChildWindowsByDefault(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32' || installed) return false;
  installed = true;
  const cp = childProcess as unknown as Record<string, AnyFn>;
  for (const name of FNS) {
    const original = cp[name];
    if (typeof original !== 'function') continue;
    cp[name] = function patched(this: unknown, ...args: unknown[]) {
      return original.apply(this, withHiddenWindow(name, args));
    };
  }
  syncBuiltinESMExports();
  return true;
}
