/**
 * Copy-on-write copies. On APFS (macOS) `cp -c` clones a file or a directory
 * tree without copying data: a 900 MB agent transcript takes ~2 ms instead of
 * ~350 ms (libuv's copyfile on macOS does not clone, even with FICLONE).
 * Elsewhere, or if cloning fails (other volume, other filesystem), copy.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync } from 'node:fs';

function cpClone(args: string[]): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('/bin/cp', ['-c', ...args], { stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

export function cloneFile(src: string, dst: string): void {
  if (!cpClone([src, dst])) copyFileSync(src, dst);
}

/** Clone a directory tree to `dst` (which must not exist yet). */
export function cloneTree(src: string, dst: string): void {
  if (!cpClone(['-R', src, dst])) cpSync(src, dst, { recursive: true });
}
