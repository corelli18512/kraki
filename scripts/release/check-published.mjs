#!/usr/bin/env node
/**
 * Fail when a shared npm package changed but its version did not.
 *
 * The release publishes each package only if its version is not on npm yet.
 * A shared package (protocol, crypto) that changed without a version bump was
 * therefore silently skipped, and its dependents were published against the
 * stale copy: tentacle 0.38.1 from npm crashed on start because protocol
 * 0.28.0 on npm lacked HEAD_CONTROL_TYPES. For each package given whose
 * version is already published, compare the packed files with the published
 * tarball; any difference is an error.
 *
 *   node scripts/release/check-published.mjs packages/protocol packages/crypto
 * Requires built packages (dist/).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: check-published.mjs <package dir>...');
  process.exit(2);
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Build provenance (dist/build-info.json) names the commit and workflow run
 * that built the package, so it differs on every build of unchanged code.
 * Only the identity it states (component, version) has to match.
 */
function contentOf(path) {
  const data = readFileSync(path);
  if (!path.endsWith('build-info.json')) return data;
  try {
    const { schemaVersion, component, version } = JSON.parse(data.toString('utf8'));
    return Buffer.from(JSON.stringify({ schemaVersion, component, version }));
  } catch {
    return data;
  }
}

/** relative path → sha256 of every file under `root`. */
function files(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(root, path), createHash('sha256').update(contentOf(path)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

function unpacked(dir) {
  const tgz = readdirSync(dir).find((n) => n.endsWith('.tgz'));
  run('tar', ['-xzf', join(dir, tgz), '-C', dir]);
  return join(dir, 'package');
}

let failed = false;
for (const dir of dirs.map((d) => resolve(d))) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const spec = `${pkg.name}@${pkg.version}`;
  let published = '';
  try { published = run('npm', ['view', spec, 'version']).trim(); } catch { /* not published */ }
  if (!published) { console.log(`${spec}: not published yet (this release publishes it)`); continue; }

  const work = mkdtempSync(join(tmpdir(), 'kraki-pubcheck-'));
  try {
    mkdirSync(join(work, 'local'));
    mkdirSync(join(work, 'npm'));
    run('pnpm', ['pack', '--pack-destination', join(work, 'local')], dir);
    run('npm', ['pack', spec, '--pack-destination', join(work, 'npm')], work);
    const local = files(unpacked(join(work, 'local')));
    const remote = files(unpacked(join(work, 'npm')));
    // Source maps embed build paths; everything else must match.
    const changed = [...new Set([...local.keys(), ...remote.keys()])]
      .filter((f) => !f.endsWith('.map') && local.get(f) !== remote.get(f))
      // The release writes build-info.json only when it publishes, after
      // this check: a local build does not have it yet.
      .filter((f) => !(f.endsWith('build-info.json') && !local.has(f)));
    if (changed.length > 0) {
      failed = true;
      console.error(`::error::${spec} is already on npm but its contents changed. Bump its version, or dependents are published against the stale copy.`);
      for (const f of changed.slice(0, 20)) console.error(`  ${f}`);
    } else {
      console.log(`${spec}: identical to npm`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
