// Overlay current workspace libraries onto the CI-only old-version npm fixture.
// dist/ alone is insufficient: entry-point exports and runtime dependencies
// must match too. Never use this helper to modify a user's real installation.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function npm(args, cwd) {
  const result = spawnSync('npm', args, {
    cwd, encoding: 'utf8', shell: process.platform === 'win32', timeout: 600_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

export function patchPackage(source, target, install = npm) {
  const read = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const current = read(source);
  const installed = read(target);
  if (current.name !== installed.name) throw new Error(`Package mismatch: ${current.name} != ${installed.name}`);
  // The CI fixture deliberately claims published versions. Keep that version
  // so its parent manifest stays consistent, but replace all runtime metadata.
  current.version = installed.version;
  delete current.devDependencies;
  delete current.scripts;
  cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true });
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(current, null, 2)}\n`);
  if (Object.keys(current.dependencies ?? {}).length || Object.keys(current.optionalDependencies ?? {}).length) {
    install(['install', '--omit=dev', '--ignore-scripts', '--no-package-lock', '--no-fund', '--no-audit'], target);
  }
  console.log(`patched complete runtime package ${target}`);
}

export function patchInstalledLibraries(repo, root) {
  for (const name of ['protocol', 'crypto']) {
    const targets = [
      join(root, '@kraki/tentacle/node_modules/@kraki', name),
      join(root, '@kraki', name),
    ].filter((path) => existsSync(join(path, 'package.json')));
    if (!targets.length) throw new Error(`Installed @kraki/${name} not found under ${root}`);
    for (const target of targets) patchPackage(join(repo, 'packages', name), target);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  patchInstalledLibraries(repo, npm(['root', '-g']));
}
