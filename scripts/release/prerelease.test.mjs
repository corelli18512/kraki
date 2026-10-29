import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DOGFOOD_TAG, INCOMING, PREVIOUS, affects, bumpPatch, cliDogfoodVersion, compareCore, dogfoodNotes, dogfoodTitle,
  krakiMacSetting, latestFormalTag, macDogfoodVersion, planComponent, publishedDogfoodRelease, recoveryActions,
  swapActions,
} from './prerelease.mjs';

test('CLI dogfood version: next formal patch, or a higher in-repo version, with -dev.N', () => {
  assert.equal(cliDogfoodVersion({ formal: '0.38.11', packageVersion: '0.38.11', number: 57 }), '0.38.12-dev.57');
  assert.equal(cliDogfoodVersion({ formal: '0.38.11', packageVersion: '0.39.0', number: 57 }), '0.39.0-dev.57');
  assert.equal(cliDogfoodVersion({ formal: '0.38.11', packageVersion: '0.38.2', number: 3 }), '0.38.12-dev.3');
  assert.throws(() => cliDogfoodVersion({ formal: '0.38.11', packageVersion: '0.38.11', number: 0 }));
});

test('Mac dogfood version: numeric short version, CFBundleVersion between formal builds', () => {
  assert.deepEqual(macDogfoodVersion({ formal: '0.2.91', formalBuild: '93', marketingVersion: '0.2.91', number: 57 }),
    { marketing: '0.2.92', build: '93.57', version: '0.2.92-dev.57' });
  assert.equal(macDogfoodVersion({ formal: '0.2.91', formalBuild: '93', marketingVersion: '0.3.0', number: 1 }).marketing, '0.3.0');
  assert.throws(() => macDogfoodVersion({ formal: '0.2.91', formalBuild: 'x', marketingVersion: '0.2.91', number: 1 }));
});

test('version helpers', () => {
  assert.equal(bumpPatch('1.2.9'), '1.2.10');
  assert.ok(compareCore('0.38.10', '0.38.9') > 0);
  assert.throws(() => compareCore('1.2', '1.2.3'));
});

test('reads KrakiMac (not iOS) versions from project.yml', () => {
  const yml = readFileSync(new URL('../../packages/arm/ios/project.yml', import.meta.url), 'utf8');
  assert.match(krakiMacSetting(yml, 'MARKETING_VERSION'), /^\d+\.\d+\.\d+$/);
  assert.match(krakiMacSetting(yml, 'CURRENT_PROJECT_VERSION'), /^[1-9][0-9]*$/);
  const synthetic = 'targets:\n  Kraki:\n    settings:\n      MARKETING_VERSION: "9.9.9"\n  KrakiMac:\n    settings:\n      base:\n        MARKETING_VERSION: "0.2.5"\n        CURRENT_PROJECT_VERSION: 7\n  Other:\n';
  assert.equal(krakiMacSetting(synthetic, 'MARKETING_VERSION'), '0.2.5');
  assert.equal(krakiMacSetting(synthetic, 'CURRENT_PROJECT_VERSION'), '7');
});

test('latest formal tag ignores dogfood, other components and sorts numerically', () => {
  const tags = ['v0.38.9', 'v0.38.11', 'v0.38.10', 'v1.0.0-beta.1', 'head-v0.9.0', 'dogfood-cli',
    'mac-v0.2.91', 'mac-v0.2.51-diag', 'mac-v0.2.100-diag', 'dogfood-mac', 'win-v0.1.0'];
  assert.deepEqual(latestFormalTag(tags, 'cli'), { tag: 'v0.38.11', version: '0.38.11' });
  assert.deepEqual(latestFormalTag(tags, 'mac'), { tag: 'mac-v0.2.100-diag', version: '0.2.100' });
  assert.equal(latestFormalTag(['head-v1.0.0'], 'cli'), null);
});

test('dogfood tags never look like formal release or updater tags', () => {
  for (const tag of Object.values(DOGFOOD_TAG)) {
    assert.ok(!/^(v|mac-v|head-v|ios-v|win-v|tentacle-v|dev-)/.test(tag), tag);
  }
});

test('previous dogfood build: the published release of the component, never a draft', () => {
  const releases = [
    { tag_name: 'dogfood-cli', prerelease: true, draft: true, id: 1 },
    { tag_name: 'dogfood-mac', prerelease: true, draft: false, id: 2 },
    { tag_name: 'v0.38.11', prerelease: false, draft: false, id: 3 },
  ];
  assert.equal(publishedDogfoodRelease(releases, 'cli'), null);
  assert.equal(publishedDogfoodRelease(releases, 'mac').id, 2);
});

test('change detection: CLI sources, dependencies, Mac sources and the embedded CLI', () => {
  for (const p of ['packages/tentacle/src/cli.ts', 'packages/protocol/src/index.ts', 'packages/pulse/src/a.ts',
    'packages/crypto/src/a.ts', 'packages/tentacle/scripts/build-local-binary.mjs', 'scripts/release/build-info.mjs',
    'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.github/workflows/release.yml', 'logo.png']) {
    assert.ok(affects('cli', p), p);
    assert.ok(affects('mac', p), p);
  }
  for (const p of ['packages/arm/ios/Kraki/Core/BuildInfo.swift', 'packages/arm/ios/project.yml',
    'packages/arm/ios/Kraki/App/Mac/MacUpdateController.swift', 'scripts/mac/build-dmg.sh',
    'packages/pulse/SwiftPulse/Sources/Pulse.swift']) {
    assert.ok(affects('mac', p), p);
    assert.ok(!affects('cli', p), p);
  }
  for (const p of ['packages/tentacle/src/__tests__/update.test.ts', 'packages/tentacle/README.md',
    'packages/arm/ios/KrakiNotification/NotificationService.swift', 'packages/arm/ios/KrakiTests/A.swift',
    'packages/arm/ios/KrakiMacTests/A.swift', 'packages/arm/web/src/App.tsx', 'packages/head/src/a.ts',
    'packages/head/package.json', 'docs/dogfood.md', 'scripts/release/prerelease.test.mjs',
    '.github/workflows/ci.yml']) {
    assert.ok(!affects('cli', p), p);
    assert.ok(!affects('mac', p), p);
  }
});

test('plans a dogfood build only when shipped files changed, unless forced', () => {
  const sha = 'a'.repeat(40);
  const changedSince = base => (base === 'v1' ? ['packages/head/src/a.ts', 'docs/x.md'] : ['packages/tentacle/src/a.ts']);
  assert.equal(planComponent({ component: 'cli', base: 'v1', changedSince, force: false }).build, false);
  assert.equal(planComponent({ component: 'cli', base: 'v1', changedSince, force: true }).build, true);
  assert.deepEqual(planComponent({ component: 'mac', base: sha, changedSince, force: false }),
    { build: true, base: sha, changed: ['packages/tentacle/src/a.ts'] });
});

// ── In-place asset replacement ──────────────────────────

/** Apply actions like the GitHub API would; throws on a name clash. */
function run(names, actions) {
  const set = new Set(names);
  for (const a of actions) {
    assert.ok(set.has(a.name), `missing ${a.name}`);
    set.delete(a.name);
    if (a.op === 'rename') {
      assert.ok(!set.has(a.to), `clash ${a.to}`);
      set.add(a.to);
    }
  }
  return [...set].sort();
}

/** Assets tagged by build: "old:x" for the previous set, "new:x" for this one. */
function simulateSwap(oldSet, newSet) {
  // state: asset name -> which build's file it holds
  const state = new Map(oldSet.map(n => [n, `old:${n}`]));
  for (const n of newSet) state.set(INCOMING + n, `new:${n}`);
  const steps = swapActions(oldSet, newSet);
  const snapshots = [new Map(state)];
  for (const a of steps) {
    const value = state.get(a.name);
    assert.ok(value, `missing ${a.name}`);
    assert.ok(!state.has(a.to), `clash ${a.to}`);
    state.delete(a.name);
    state.set(a.to, value);
    snapshots.push(new Map(state));
  }
  return snapshots;
}

function recover(state) {
  const next = new Map(state);
  for (const a of recoveryActions([...state.keys()])) {
    const value = next.get(a.name);
    assert.ok(value, `missing ${a.name}`);
    next.delete(a.name);
    if (a.op === 'rename') {
      assert.ok(!next.has(a.to), `clash ${a.to}`);
      next.set(a.to, value);
    }
  }
  return next;
}

const stableSet = (state, build) => [...state].filter(([, v]) => v.startsWith(`${build}:`)).map(([k]) => k).sort();

test('swap replaces every asset and leaves only previous copies behind', () => {
  const names = ['SHA256SUMS.txt', 'kraki-cli-linux-x64', 'provenance.json', 'release-manifest.json'];
  const snapshots = simulateSwap(names, names);
  const done = snapshots.at(-1);
  for (const n of names) assert.equal(done.get(n), `new:${n}`);
  assert.deepEqual(run([...done.keys()], recoveryActions([...done.keys()])), names);
});

test('an interrupted swap always recovers one complete set, never a mix', () => {
  const oldSet = ['Kraki.app.zip', 'Kraki.dmg', 'SHA256SUMS.txt', 'dropped.txt', 'provenance.json'];
  const newSet = ['Kraki.app.zip', 'Kraki.dmg', 'SHA256SUMS.txt', 'appcast-dogfood.xml', 'provenance.json'];
  const snapshots = simulateSwap(oldSet, newSet);
  snapshots.forEach((state, i) => {
    const after = recover(state);
    const names = [...after.keys()].sort();
    assert.ok(!names.some(n => n.startsWith(INCOMING) || n.startsWith(PREVIOUS)), `step ${i}: ${names}`);
    const oldNames = stableSet(after, 'old'), newNames = stableSet(after, 'new');
    // Rolled back to the old set until every incoming asset was swapped in.
    if (i < snapshots.length - 1) {
      assert.deepEqual(newNames, [], `step ${i}`);
      assert.deepEqual(oldNames, [...oldSet].sort(), `step ${i}`);
      for (const [name, value] of after) assert.equal(value, `old:${name}`);
    } else {
      assert.deepEqual(oldNames, [], `step ${i}`);
      assert.deepEqual(newNames, [...newSet].sort(), `step ${i}`);
    }
  });
});

test('an interrupted upload only removes the incoming copies', () => {
  assert.deepEqual(recoveryActions(['a', 'b', `${INCOMING}a`]), [{ op: 'delete', name: `${INCOMING}a` }]);
  assert.deepEqual(recoveryActions(['a', 'b']), []);
});

test('title and notes name the version, commit and changes', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(dogfoodTitle({ component: 'cli', version: '0.39.0-dev.12' }), 'Kraki CLI dogfood 0.39.0-dev.12');
  assert.equal(dogfoodTitle({ component: 'mac', version: '0.2.92-dev.12', bundleBuild: '93.12' }), 'Kraki for Mac dogfood 0.2.92 (93.12)');
  const notes = dogfoodNotes({
    component: 'mac', repo: 'o/r', version: '0.2.92-dev.12', bundleBuild: '93.12', tentacleVersion: '0.39.0-dev.12',
    sha, runURL: 'https://run', base: { ref: 'mac-v0.2.91', label: 'mac-v0.2.91' },
    commits: [{ sha: 'f'.repeat(40), message: 'feat: thing\n\nbody' }],
  });
  assert.match(notes, /`0\.2\.92` \(build `93\.12`\), built-in tentacle `0\.39\.0-dev\.12`/);
  assert.match(notes, /commit\/0123456789abcdef/);
  assert.match(notes, /## Changes since mac-v0\.2\.91\n\n- feat: thing \(fffffff\)\n/);
  assert.match(notes, /releases\/download\/dogfood-mac\/appcast-dogfood\.xml/);
  assert.match(notes, /compare\/mac-v0\.2\.91\.\.\.0123456789abcdef0123456789abcdef01234567/);
  const cli = dogfoodNotes({ component: 'cli', repo: 'o/r', version: '0.39.0-dev.12', sha, runURL: 'u', base: { ref: sha, label: 'x' }, commits: [] });
  assert.match(cli, /KRAKI_CHANNEL=dogfood/);
  assert.match(cli, /No new commits/);
});
