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

// npm's global file: tarball edge is not a publishable dependency contract and
// can be reported as invalid by `npm ls` after installation. Only the CI parent
// manifest is normalized: the installed bytes still come from our local tarball,
// and the complete runtime dependency check remains mandatory.
export function normalizeFixtureTarball(packageDir, name, installedVersion) {
  const file = join(packageDir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (pkg.name !== '@kraki/tentacle') throw new Error(`Not a Tentacle fixture: ${pkg.name}`);
  if (!pkg.dependencies?.[name]?.startsWith('file:')) return;
  pkg.dependencies[name] = installedVersion;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function patchInstalledLibraries(repo, root) {
  for (const name of ['protocol', 'crypto', 'pulse']) {
    const targets = [
      join(root, '@kraki/tentacle/node_modules/@kraki', name),
      join(root, '@kraki', name),
    ].filter((path) => existsSync(join(path, 'package.json')));
    if (!targets.length) throw new Error(`Installed @kraki/${name} not found under ${root}`);
    for (const target of targets) patchPackage(join(repo, 'packages', name), target);
    if (name === 'pulse') {
      const installed = JSON.parse(readFileSync(join(targets[0], 'package.json'), 'utf8'));
      normalizeFixtureTarball(join(root, '@kraki/tentacle'), '@kraki/pulse', installed.version);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  patchInstalledLibraries(repo, npm(['root', '-g']));
}
