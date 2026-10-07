import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedPaths, testScope } from './test-scope.mjs';

const none = { typescript: false, native: false, binary: false, resilience: false };
const all = { typescript: true, native: true, binary: true, resilience: true };
const ts = { ...none, typescript: true };
const web = { ...ts };
const native = { ...none, native: true, resilience: true };
const binary = { ...ts, binary: true };
const tentacle = { ...binary, resilience: true };
const relay = { ...ts, resilience: true };
for (const [name, paths, expected] of [
  ['docs do not launch platform tests', ['README.md', 'docs/a.md', 'packages/arm/ios/README.md'], none],
  ['runtime markdown is not documentation', ['packages/tentacle/prompts/system.md'], tentacle],
  ['native-only', ['packages/arm/ios/Kraki/App/AppState.swift'], native],
  ['vendor audio safety stays covered', ['packages/arm/ios/Vendor/VoiceInputCore/Package.swift'], native],
  ['web-only', ['packages/arm/web/src/App.tsx'], ts],
  ['other TypeScript packages', ['packages/monitor/src/cli.ts'], ts],
  ['head-only', ['packages/head/src/relay.ts'], relay],
  ['chaos stack', ['packages/tests/src/chaos/proxy.ts', 'scripts/chaos/run-native.sh'], relay],
  ['Windows adapter does not launch native apps', ['packages/tentacle/src/adapters/codex.ts'], tentacle],
  ['shared contract affects all clients', ['packages/protocol/src/types.ts'], all],
  ['crypto must stay compatible with the Swift client', ['packages/crypto/src/index.ts'], { ...tentacle, native: true }],
  ['other workflows are linted in the scope job', ['.github/workflows/release.yml', '.github/actionlint.yaml'], none],
  ['lockfile', ['pnpm-lock.yaml'], all],
  ['CI rules', ['.github/workflows/ci.yml'], all],
  ['scope script', ['scripts/ci/test-scope.mjs'], all],
  ['root compiler config', ['tsconfig.json'], all],
  ['unknown config is conservative', ['new-build-config.json'], all],
  ['installer', ['install.ps1'], binary],
  ['web installer copy', ['packages/arm/web/public/install.ps1'], binary],
  ['daemon smoke script', ['packages/tentacle/scripts/daemon-release-smoke.mjs'], tentacle],
  ['Windows E2E script', ['scripts/e2e/windows-installer.test.ps1'], binary],
  ['native diagnostics', ['scripts/diag/run-native-tests.sh'], native],
  ['mixed files union their scopes', ['packages/head/src/a.ts', 'packages/arm/ios/project.yml'], { ...relay, native: true }],
]) {
  test(name, () => assert.deepEqual(testScope(paths), expected));
}
test('manual full regression does not depend on changed paths', () => {
  assert.deepEqual(testScope([], true), all);
});
test('PR routing includes earlier commits and deleted paths, preserving spaces', () => {
  const paths = changedPaths({ pull_request: { base: { sha: 'base' }, head: { sha: 'head' } } }, args => {
    assert.deepEqual(args, ['diff', '--no-renames', '--name-only', '-z', 'base...head']);
    return 'packages/arm/ios/deleted file.swift\0README.md\0';
  });
  assert.deepEqual(testScope(paths), native);
});
test('main push uses before/after range', () => {
  assert.deepEqual(changedPaths({ before: 'a', after: 'b' }, args => {
    assert.deepEqual(args, ['diff', '--no-renames', '--name-only', '-z', 'a', 'b']);
    return '';
  }), []);
});
test('cross-package moves retain the source scope even when moved to docs', () => {
  const paths = changedPaths({ before: 'a', after: 'b' }, args => {
    assert.ok(args.includes('--no-renames'));
    return 'packages/tentacle/src/removed.ts\0docs/removed.ts\0';
  });
  assert.deepEqual(testScope(paths), tentacle);
});
test('missing push history requests conservative full coverage', () => {
  assert.equal(changedPaths({ before: '000000', after: 'b' }), null);
  assert.equal(changedPaths({}), null);
});

const runner = fileURLToPath(new URL('../test-native.sh', import.meta.url));
for (const option of ['-project', '-scheme', '-destination', 'KRAKI_RUN_PERF_TESTS=1']) {
  test(`native runner rejects ${option} before launching anything`, () => {
    const result = spawnSync('bash', [runner, 'mac', option], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Only .* selectors are supported/);
  });
}
for (const variable of ['KRAKI_ALLOW_TEST_MICROPHONE', 'SIMCTL_CHILD_KRAKI_ALLOW_TEST_MICROPHONE']) {
  test(`hardware-free runner rejects ${variable} before launching anything`, () => {
    const result = spawnSync('bash', [runner, 'mac'], {
      encoding: 'utf8', env: { ...process.env, [variable]: '1' },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /runner is hardware-free/);
  });
}
