/**
 * Where to find an agent's CLI when it is not on PATH.
 *
 * Desktop apps ship the same CLI Kraki drives, so a user who only installed
 * the app (never the command-line tool) still has a working agent:
 *
 *   - Codex app (bundle com.openai.codex, currently "ChatGPT.app", previously
 *     "Codex.app") bundles the codex CLI at
 *     Contents/Resources/codex-cli/bin/codex and shares ~/.codex (login).
 *   - Claude desktop app downloads Claude Code at runtime into
 *     ~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude.
 *
 * PATH always wins; these are fallbacks. macOS only.
 */

import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** Compare dotted versions numerically ("2.1.10" > "2.1.9"); non-numeric parts last. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10);
    const y = Number.parseInt(pb[i] ?? '0', 10);
    if (Number.isNaN(x) || Number.isNaN(y)) return (pa[i] ?? '').localeCompare(pb[i] ?? '');
    if (x !== y) return x - y;
  }
  return 0;
}

export interface AppCliDeps {
  os: string;
  home: string;
  isExecutable: (path: string) => boolean;
  listDir: (path: string) => string[];
}

const defaultDeps = (): AppCliDeps => ({
  os: platform(),
  home: homedir(),
  isExecutable: executable,
  listDir: (path) => { try { return readdirSync(path); } catch { return []; } },
});

/** Candidate CLI paths inside desktop apps, most preferred first. */
export function appBundledCliCandidates(name: string, deps: AppCliDeps = defaultDeps()): string[] {
  if (deps.os !== 'darwin') return [];
  const appDirs = ['/Applications', join(deps.home, 'Applications')];
  if (name === 'codex') {
    return appDirs.flatMap((dir) => ['ChatGPT.app', 'Codex.app'].map((app) =>
      join(dir, app, 'Contents', 'Resources', 'codex-cli', 'bin', 'codex')));
  }
  if (name === 'claude') {
    const root = join(deps.home, 'Library', 'Application Support', 'Claude', 'claude-code');
    return deps.listDir(root)
      .filter((v) => /^\d/.test(v))
      .sort(compareVersions)
      .reverse()
      .map((v) => join(root, v, 'claude.app', 'Contents', 'MacOS', 'claude'));
  }
  return [];
}

/** The first executable CLI shipped inside a desktop app, if any. */
export function findAppBundledCli(name: string, deps: AppCliDeps = defaultDeps()): string | undefined {
  return appBundledCliCandidates(name, deps).find((p) => deps.isExecutable(p));
}
