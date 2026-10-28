import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  affects, bumpPatch, cliPrereleaseVersion, compareCore, krakiMacSetting, latestFormalTag, macPrereleaseVersion,
  planComponent, prereleaseNumber, prereleaseTag, publishedPrereleases, pruneTargets,
} from './prerelease.mjs';

test('CLI prerelease version: next formal patch, or a higher in-repo version, with -dev.N', () => {
  assert.equal(cliPrereleaseVersion({ formal: '0.38.11', packageVersion: '0.38.11', number: 57 }), '0.38.12-dev.57');
  assert.equal(cliPrereleaseVersion({ formal: '0.38.11', packageVersion: '0.39.0', number: 57 }), '0.39.0-dev.57');
  assert.equal(cliPrereleaseVersion({ formal: '0.38.11', packageVersion: '0.38.2', number: 3 }), '0.38.12-dev.3');
  assert.throws(() => cliPrereleaseVersion({ formal: '0.38.11', packageVersion: '0.38.11', number: 0 }));
});

test('Mac prerelease: numeric short version, CFBundleVersion between formal builds', () => {
  assert.deepEqual(macPrereleaseVersion({ formal: '0.2.91', formalBuild: '93', marketingVersion: '0.2.91', number: 57 }),
    { marketing: '0.2.92', build: '93.57', version: '0.2.92-dev.57' });
  assert.equal(macPrereleaseVersion({ formal: '0.2.91', formalBuild: '93', marketingVersion: '0.3.0', number: 1 }).marketing, '0.3.0');
  assert.throws(() => macPrereleaseVersion({ formal: '0.2.91', formalBuild: 'x', marketingVersion: '0.2.91', number: 1 }));
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

test('latest formal tag ignores prereleases, other components and sorts numerically', () => {
  const tags = ['v0.38.9', 'v0.38.11', 'v0.38.10', 'v1.0.0-beta.1', 'head-v0.9.0', 'dev-cli-0.38.12-dev.5',
    'mac-v0.2.91', 'mac-v0.2.51-diag', 'mac-v0.2.100-diag', 'dev-mac-0.2.92-dev.5', 'win-v0.1.0'];
  assert.deepEqual(latestFormalTag(tags, 'cli'), { tag: 'v0.38.11', version: '0.38.11' });
  assert.deepEqual(latestFormalTag(tags, 'mac'), { tag: 'mac-v0.2.100-diag', version: '0.2.100' });
  assert.equal(latestFormalTag(['head-v1.0.0'], 'cli'), null);
});

test('prerelease tags never look like formal release or updater tags', () => {
  for (const tag of [prereleaseTag('cli', '0.38.12-dev.5'), prereleaseTag('mac', '0.2.92-dev.5')]) {
    assert.ok(!/^(v|mac-v|head-v|win-v|tentacle-v)/.test(tag), tag);
  }
  assert.equal(prereleaseNumber('dev-cli-0.38.12-dev.57', 'cli'), 57);
  assert.equal(prereleaseNumber('dev-cli-0.38.12-dev.57', 'mac'), null);
});

test('change detection: CLI sources, Mac sources and the embedded CLI', () => {
  for (const p of ['packages/tentacle/src/cli.ts', 'packages/protocol/src/index.ts', 'packages/pulse/src/a.ts',
    'packages/crypto/src/a.ts', 'packages/tentacle/scripts/build-local-binary.mjs', 'scripts/release/build-info.mjs']) {
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
    'pnpm-lock.yaml', 'docs/prerelease.md', '.github/workflows/release.yml']) {
    assert.ok(!affects('cli', p), p);
    assert.ok(!affects('mac', p), p);
  }
});

test('plans a prerelease only when shipped files changed, unless forced', () => {
  const changedSince = base => (base === 'v1' ? ['packages/head/src/a.ts', 'docs/x.md'] : ['packages/tentacle/src/a.ts']);
  assert.equal(planComponent({ component: 'cli', base: 'v1', changedSince, force: false }).build, false);
  assert.equal(planComponent({ component: 'cli', base: 'v1', changedSince, force: true }).build, true);
  assert.deepEqual(planComponent({ component: 'mac', base: 'dev-mac-0.2.92-dev.4', changedSince, force: false }),
    { build: true, base: 'dev-mac-0.2.92-dev.4', changed: ['packages/tentacle/src/a.ts'] });
});

test('previous prerelease: newest published one of the component', () => {
  const releases = [
    { tag_name: 'dev-cli-0.38.12-dev.9', prerelease: true, draft: false },
    { tag_name: 'dev-cli-0.38.12-dev.11', prerelease: true, draft: false },
    { tag_name: 'dev-cli-0.38.12-dev.12', prerelease: true, draft: true },
    { tag_name: 'dev-mac-0.2.92-dev.13', prerelease: true, draft: false },
    { tag_name: 'v0.38.11', prerelease: false, draft: false },
  ];
  assert.deepEqual(publishedPrereleases(releases, 'cli').map(r => r.tag_name), ['dev-cli-0.38.12-dev.11', 'dev-cli-0.38.12-dev.9']);
});

test('retention keeps the newest 10 and removes only stale orphan tags', () => {
  const releases = [];
  for (let n = 1; n <= 13; n++) releases.push({ tag_name: `dev-cli-0.38.12-dev.${n}`, prerelease: true, draft: false });
  releases.push({ tag_name: 'dev-mac-0.2.92-dev.1', prerelease: true, draft: false }, { tag_name: 'v0.38.11', prerelease: false, draft: false });
  const tags = [...releases.filter(r => r.tag_name.startsWith('dev-cli-')).map(r => r.tag_name),
    'dev-cli-0.38.12-dev.14', 'dev-cli-0.38.12-dev.15', 'dev-cli-0.38.12-dev.16', 'dev-cli-0.38.12-dev.17'];
  const result = pruneTargets({
    releases, tags, component: 'cli', currentTag: 'dev-cli-0.38.12-dev.16', activeRefs: ['dev-cli-0.38.12-dev.15'],
  });
  assert.deepEqual(result.releases, ['dev-cli-0.38.12-dev.3', 'dev-cli-0.38.12-dev.2', 'dev-cli-0.38.12-dev.1']);
  // 14: cancelled build, no release -> removed. 15: still building. 16: current. 17: newer.
  assert.deepEqual(result.orphanTags, ['dev-cli-0.38.12-dev.14']);
  assert.throws(() => pruneTargets({ releases, tags, component: 'cli', currentTag: 'v0.38.11' }));
});
