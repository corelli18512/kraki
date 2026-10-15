import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuildInfo } from './build-info.mjs';
import { createManifest, checkManifest, verificationArgs, checkVerifiedIdentity, requireReleaseArtifacts } from './artifacts.mjs';

const commit = 'a'.repeat(40);
const env = {
  KRAKI_BUILD_CHANNEL: 'release', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'corelli18512/kraki',
  GITHUB_SHA: commit, GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW_REF: 'corelli18512/kraki/.github/workflows/release.yml@refs/tags/v1.2.3',
};
const build = (overrides = {}) => createBuildInfo({ component: 'cli', version: '1.2.3', commit, env: { ...env, ...overrides } });

test('embeds immutable source and run attempt, without secrets', () => {
  const info = build({ GH_TOKEN: 'must-not-be-in-artifact' });
  assert.equal(info.commit, commit);
  assert.equal(info.runURL, 'https://github.com/corelli18512/kraki/actions/runs/123456789/attempts/2');
  assert.equal(info.channel, 'release');
  assert.ok(!JSON.stringify(info).includes('must-not-be-in-artifact'));
});
test('local builds do not claim CI identity even in an inherited GitHub environment', () => {
  assert.deepEqual(build({ KRAKI_BUILD_CHANNEL: '' }), { schemaVersion: 1, component: 'cli', version: '1.2.3', channel: 'local' });
});
test('CI dry runs are distinguishable from releases', () => assert.equal(build({ KRAKI_BUILD_CHANNEL: 'ci' }).channel, 'ci'));
test('PR builds carry a CI identity but cannot claim release provenance', () => {
  assert.equal(build({ KRAKI_BUILD_CHANNEL: 'ci', GITHUB_REF: 'refs/pull/524/merge' }).channel, 'ci');
  assert.throws(() => build({ GITHUB_REF: 'refs/pull/524/merge' }), /Invalid build ref/);
});
test('partial reruns cannot publish an incomplete platform set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraki-release-inventory-'));
  try {
    writeFileSync(join(dir, 'kraki-cli-linux-x64'), 'one matrix job');
    assert.throws(() => requireReleaseArtifacts(dir, 'cli', '1.2.3'), /rerun ALL jobs/);
    writeFileSync(join(dir, 'Kraki-Setup-1.2.3-x64.exe'), 'installer');
    requireReleaseArtifacts(dir, 'windows', '1.2.3');
    assert.throws(() => requireReleaseArtifacts(dir, 'windows', '9.9.9'), /Missing release artifact/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const [key, value] of Object.entries({
  GITHUB_SHA: 'b'.repeat(40), GITHUB_REPOSITORY: 'attacker/kraki', GITHUB_RUN_ID: '0',
  GITHUB_RUN_ATTEMPT: '../2', GITHUB_WORKFLOW_REF: 'corelli18512/kraki/.github/workflows/ci.yml@main',
  GITHUB_ACTIONS: 'false', GITHUB_REF: '', KRAKI_BUILD_CHANNEL: 'verified', KRAKI_BUILD_NUMBER: 'bad',
})) {
  test(`rejects invalid ${key}`, () => assert.throws(() => build({ [key]: value })));
}
test('accepts iOS workflow with separate build number and Run ID', () => {
  const info = build({ GITHUB_WORKFLOW_REF: 'corelli18512/kraki/.github/workflows/ios-testflight.yml@refs/heads/main', KRAKI_BUILD_NUMBER: '24' });
  assert.equal(info.buildNumber, '24');
  assert.notEqual(info.buildNumber, info.runId);
});
test('Windows installer gets its own workflow identity', () => {
  const info = build({ GITHUB_WORKFLOW_REF: 'corelli18512/kraki/.github/workflows/windows-release.yml@refs/tags/win-v1.2.3' });
  assert.equal(info.workflow, '.github/workflows/windows-release.yml');
});
test('verification pins repository, signer, ref, commit and runner policy', () => {
  const args = verificationArgs('app.exe', 'proof.json', env);
  for (const expected of ['--repo', 'corelli18512/kraki', '--signer-workflow',
    'corelli18512/kraki/.github/workflows/release.yml', '--source-digest', commit,
    '--source-ref', env.GITHUB_REF, '--deny-self-hosted-runners', '--bundle', 'proof.json']) assert.ok(args.includes(expected));
});
test('proof must belong to this exact workflow run and attempt', () => {
  const result = { verificationResult: { signature: { certificate: {
    runInvocationURI: 'https://github.com/corelli18512/kraki/actions/runs/123456789/attempts/2',
    buildSignerURI: `https://github.com/${env.GITHUB_WORKFLOW_REF}`,
  } } } };
  checkVerifiedIdentity([result], env);
  assert.throws(() => checkVerifiedIdentity([result], { ...env, GITHUB_RUN_ATTEMPT: '1' }), /exact workflow/);
  assert.throws(() => checkVerifiedIdentity([result], { ...env, GITHUB_RUN_ID: '987' }), /exact workflow/);
  assert.throws(() => checkVerifiedIdentity([result], { ...env, GITHUB_WORKFLOW_REF: 'evil/workflow' }), /exact workflow/);
  assert.throws(() => checkVerifiedIdentity([], env));
});
test('manifest detects altered, missing, duplicate and unsafe artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraki-provenance-test-'));
  try {
    writeFileSync(join(dir, 'app.exe'), 'original');
    const manifest = await createManifest(dir, build());
    await checkManifest(dir, manifest);
    writeFileSync(join(dir, 'app.exe'), 'tampered');
    await assert.rejects(checkManifest(dir, manifest), /mismatch/);
    writeFileSync(join(dir, 'app.exe'), 'original');
    await assert.rejects(checkManifest(dir, { ...manifest, artifacts: [...manifest.artifacts, ...manifest.artifacts] }), /duplicate/);
    await assert.rejects(checkManifest(dir, { ...manifest, artifacts: [{ name: '../app.exe' }] }), /Unsafe/);
    await assert.rejects(checkManifest(dir, { ...manifest, artifacts: [{ name: 'missing.exe' }] }));
    await assert.rejects(checkManifest(dir, { ...manifest, artifacts: [] }));
    symlinkSync(join(dir, 'app.exe'), join(dir, 'alias.exe'));
    await assert.rejects(createManifest(dir, build()), /Unsafe/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('manifest refuses to accidentally re-attest old proof/output files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraki-provenance-test-'));
  try {
    await assert.rejects(createManifest(dir, build()), /No release artifacts/);
    writeFileSync(join(dir, 'provenance.json'), '{}');
    await assert.rejects(createManifest(dir, build()), /not fresh/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('release workflows keep proof-before-publish ordering and immutable source checkouts', () => {
  const release = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.ok(release.includes('"$release_sha" != "$GITHUB_SHA"'));
  assert.ok(!release.includes('ref: ${{ needs.prepare.outputs.checkout_ref }}'));
  assert.ok(release.indexOf('Verify provenance before publication') < release.indexOf('- name: Create GitHub Release'));
  assert.ok(release.includes('Verify downloaded release assets'));
  assert.ok(release.includes('pattern: build-kraki-*-${{ github.run_attempt }}'));
  assert.ok(release.includes('--provenance'));
  const ios = readFileSync(new URL('../../.github/workflows/ios-testflight.yml', import.meta.url), 'utf8');
  assert.ok(ios.indexOf('Verify provenance before submitting') < ios.indexOf('- name: Upload IPA to TestFlight'));
  assert.ok(ios.includes('--file "$RUNNER_TEMP/ios-provenance/Kraki.ipa"'));
  assert.ok(ios.includes('--latest=false --prerelease'));
  const windows = readFileSync(new URL('../../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
  assert.ok(windows.indexOf('Verify provenance before publication') < windows.indexOf('- name: Publish Windows release'));
  assert.ok(windows.includes('node scripts/release/verify-desktop.mjs'));
  assert.ok(windows.includes('packages/desktop/kraki/kraki.exe'));
  assert.ok(windows.includes('--latest=false'));
});
