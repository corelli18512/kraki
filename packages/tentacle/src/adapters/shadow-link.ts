import { linkSync, copyFileSync, lstatSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';

/**
 * Make `src` available at `dest` inside a shadow config dir (Claude home, Copilot config). Symlinks need
 * admin or Developer Mode on Windows, so there directories become junctions
 * and files hard links (copies across volumes). Returns false on failure.
 */
export function linkIntoShadow(src: string, dest: string, os: NodeJS.Platform = process.platform): boolean {
  removeShadowEntry(dest);
  try {
    if (os !== 'win32') {
      symlinkSync(src, dest);
      return true;
    }
    if (statSync(src).isDirectory()) {
      symlinkSync(src, dest, 'junction');
    } else {
      try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove a previous link (or a real file/dir Claude wrote) at `dest` —
 *  never what a link points to. Windows junctions are directories to rm(). */
function removeShadowEntry(dest: string): void {
  let st;
  try { st = lstatSync(dest); } catch { return; }
  try {
    if (st.isSymbolicLink()) {
      try { unlinkSync(dest); } catch { rmdirSync(dest); }
    } else if (st.isDirectory()) {
      rmSync(dest, { recursive: true, force: true });
    } else {
      unlinkSync(dest);
    }
  } catch { /* linking reports the failure */ }
}

