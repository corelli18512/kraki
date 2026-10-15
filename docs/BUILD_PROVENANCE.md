# Build source, GitHub Run ID and artifact provenance

Every new official Kraki release carries a build identity and signed build
provenance. These are complementary to Apple code signing / notarization or
Windows Authenticode, not replacements for them.

- **Run ID** opens the Actions execution that built this version. A rerun keeps
  the ID, so we also embed the attempt number.
- **Source commit** identifies the exact checked-out source, not the latest main.
- **Provenance** is a cryptographically signed workflow statement about a file's
  SHA-256 digest. Verify the file, repository, workflow and expected source; merely
  displaying a Run ID or downloading a checksum list is not verification.

The native apps show these links in Settings → About. The Windows desktop app
shows them in About. `kraki build-info` (or `kraki build-info --json`) exposes them
for CLI binaries on Linux/macOS/Windows and npm installs. `kraki --version` retains
its existing machine-readable output. Local builds say “Local build”; CI dry runs
have build records but do not claim a release attestation.

## Verify a GitHub download

With a recent GitHub CLI:

```sh
gh attestation verify Kraki.dmg \
  --repo corelli18512/kraki \
  --signer-workflow corelli18512/kraki/.github/workflows/release.yml
```

Use the file actually downloaded, not an extracted app when the attested subject
is a ZIP/DMG/tar.gz. Substitute the Linux/macOS CLI, Windows CLI EXE, or Sparkle
update ZIP as appropriate. Each final distribution file is attested separately
(or listed as a separate subject in a shared bundle).

For the Windows **GUI installer**, use:

```sh
gh attestation verify Kraki-Setup-VERSION-x64.exe \
  --repo corelli18512/kraki \
  --signer-workflow corelli18512/kraki/.github/workflows/windows-release.yml
```

Replace `VERSION` with the downloaded version. For stronger policy, also pass
`--source-ref refs/tags/TAG --source-digest FULL_COMMIT_SHA`, using the intended
release's tag and source commit. Do not blindly trust identity values supplied by
an arbitrary downloaded file. A public repository alone is not a sufficient
allowlist for every workflow it might run.

Releases include `release-manifest.json`, `SHA256SUMS.txt`, and `provenance.json`.
The manifest records the source, run/attempt, version and final artifact digests.
The manifest and checksum list themselves are attested. The proof bundle can also
be supplied with `--bundle provenance.json`; trust-root data may still need
network access unless separately provisioned for offline verification.

The in-app “Build provenance” link opens the run summary, which contains GitHub's
attestation links. It does **not** mean the app has independently verified itself.
The release attachments provide a durable copy independent of Actions log expiry.

## iOS / TestFlight / App Store

The iOS workflow embeds the run and source before archiving. It signs/exports the
IPA, then generates and verifies provenance for **the same IPA submitted to
Apple**. Exported build metadata is checked against the source resource.

Apple processes apps for distribution. The uploaded IPA's digest is not a digest
of the app installed on an iPhone. We do not claim byte-for-byte verification of
Apple's processed download, or that Apple attests to our GitHub source.

A public `ios-build-VERSION-BUILD-ATTEMPT` prerelease record preserves the signed
manifest, checksums and proof without taking over the CLI's `latest` release.
The record includes the Apple build number, source, run and submission context.
It does not announce that Apple processing/review has completed. The IPA itself
remains in the workflow artifacts (currently retained for 90 days); the public
proofs do not make it a supported sideload distribution. To independently verify
the IPA bytes, obtain that original file and use:

```sh
gh attestation verify Kraki.ipa \
  --repo corelli18512/kraki \
  --signer-workflow corelli18512/kraki/.github/workflows/ios-testflight.yml \
  --bundle provenance.json
```

The iOS build number (`GITHUB_RUN_NUMBER`) and global Run ID (`GITHUB_RUN_ID`) are
different fields; neither replaces the other.

## npm

The npm publication workflow uses `npm publish --provenance`. It embeds
`dist/build-info.json` into each new package before packing and publishing the
exact tarball. npm exposes the package's provenance on its version page; npm's
signature/provenance verification tooling (e.g. `npm audit signatures` in a
project using the package) validates registry-distributed dependencies.

An already published version is not republished or relabeled with a newer Run ID.
Its existing provenance belongs to its original build. GitHub Release provenance
for CLI binaries is separate from npm provenance for package tarballs.

## Release maintenance

1. Official builds use one immutable source SHA. A release workflow dispatched on
   main to build some other tag now **fails**: dispatch on that tag itself instead.
   Example: `gh workflow run release.yml --ref vX.Y.Z -f mode=publish -f tag=vX.Y.Z`.
2. Build identity is generated from the allowed workflow context. The source SHA
   must equal the workflow's `GITHUB_SHA`; all downstream Release build jobs check
   out the resolved SHA rather than re-resolving a movable tag.
3. Compile, sign, notarize/staple where applicable, and finish packaging **before**
   hashing and attesting. Never modify a distribution file after its proof is made.
4. Verification is fail-closed before publication. It checks the artifact digest,
   allowed repository/workflow, source ref/SHA, exact run/attempt from the signing
   certificate, and GitHub-hosted runner policy.
   GitHub downloads are reverified after publication. Publication across multiple
   services is not atomic: a later failure cannot undo an earlier npm/Apple upload.
5. `.github/workflows/windows-release.yml` builds the bundled CLI and web UI from
   the same commit, checks metadata inside the packaged ASAR, smoke-tests the
   staged helper, and attests the final NSIS installer. `mode=dry-run` produces
   artifacts without publishing. Authenticode still requires a separate signing
   certificate/service; an attestation does not remove SmartScreen warnings.
6. Proof generation uses the existing commit-pinned official attestation action
   with GitHub OIDC and short-lived Sigstore certificates. No long-lived custom
   provenance signing key is introduced.
7. New release workflows must be explicitly added to `scripts/release/build-info.mjs`
   and their UI/link validation allowlists. Keep artifact inventories complete.

This establishes a verifiable **claim by the trusted build workflow**, not an
independent reproducible-build audit, absence-of-malware guarantee, or a defense
against administrators compromising the trusted release workflow itself.
Historical manually built artifacts cannot retroactively be claimed as having
been built by a new Actions run. Ship a new version through the new workflow.

## Tests

```sh
node --test scripts/release/*.test.mjs packages/desktop/test/*.test.cjs
pnpm --filter @kraki/tentacle exec vitest run src/__tests__/build-info.test.ts src/__tests__/cli.test.ts
pnpm --filter @kraki/arm-web exec vitest run src/components/layout/BuildProvenance.test.tsx
```

Native `BuildInfoTests` cover metadata parsing, safe links, local/dry-run states,
and presence of the resource in the real app bundle on iOS and macOS. Optional
screenshots render the production views with synthetic fixture data by setting
`TEST_RUNNER_KRAKI_SNAPSHOT_DIR` when invoking `xcodebuild test`.
