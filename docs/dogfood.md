# Dogfood releases (CLI and Kraki for Mac)

Every merge to `main` that changes the CLI or Kraki for Mac rebuilds that
component for the owner and internal testers. The build replaces the
contents of one of exactly **two fixed GitHub releases**:

| Release | Contents |
| --- | --- |
| [`dogfood-cli`](https://github.com/corelli18512/kraki/releases/tag/dogfood-cli) | the CLI binaries and macOS `.app.tar.gz` files, same names as a formal `v*` release |
| [`dogfood-mac`](https://github.com/corelli18512/kraki/releases/tag/dogfood-mac) | `Kraki.dmg`, `kraki-mac-gui-universal.app.tar.gz`, the Sparkle update `Kraki-<CFBundleVersion>.app.zip` (for example `Kraki-93.57.app.zip`) and the dogfood Sparkle feed `appcast-dogfood.xml` |

Both releases also contain `release-manifest.json`, `SHA256SUMS.txt` and
`provenance.json`. They cover every asset except `appcast-dogfood.xml`,
which carries its own EdDSA signature and is replaced by every formal Mac
release ([Dogfood Sparkle feed](#dogfood-sparkle-feed)). Both are marked *Pre-release* and are never GitHub's
"latest". Regular users never receive a dogfood build through any automatic
path. Formal releases stay manual and unchanged: push a `v*` / `mac-v*` /
`head-v*` tag, or run `release.yml` with `mode=publish`.

The release list only ever holds these two dogfood entries, so a dogfood
build never pushes a formal release off the first page of releases that
older CLIs read (`per_page=20` up to 0.38.11).

## How it runs

1. `CI` completes successfully for a push to `main`.
2. `.github/workflows/prerelease.yml` checks out the commit CI tested and runs
   `node scripts/release/prerelease.mjs plan`.
   - If `main` has already moved on, nothing is built. CI on `main`
     cancels the older run, and the newer commit's own CI run dogfoods
     everything since the last build.
   - For each component, the plan diffs the commit against the previous
     dogfood build: the commit its release's tag points at. If the release
     doesn't exist yet, it diffs against the latest formal tag. Only files
     the component ships count:
     - **CLI and Mac**: `packages/tentacle`, `packages/protocol`,
       `packages/pulse` and `packages/crypto` (without their Swift packages);
       the dependencies (`package.json`, `pnpm-lock.yaml`,
       `pnpm-workspace.yaml`, `.npmrc`); `logo.png`; `scripts/release/`; and
       `.github/workflows/release.yml`.
     - **Mac only**: the Swift packages, `packages/arm/ios` except the
       iOS-only targets (`KrakiNotification`, `KrakiTests`, `KrakiUITests`,
       `KrakiVoiceUITests`, `KrakiMacTests`, `ExportOptions-AppStore.plist`),
       and `scripts/mac`.
     - Tests (`__tests__/`, `*.test.*`) and Markdown never count.
3. For each changed component, the workflow dispatches `release.yml` on
   `main` with `mode=prerelease`.
   - `prepare` refuses the run unless all of these hold:
     - the run is on `refs/heads/main`;
     - the commit is the one that was planned and is on `origin/main`;
     - the CI `Validate` check passed for it.
   - The same jobs as a formal release build, sign, notarize, staple, attest
     and verify the artifacts.
   - Only the formal-only checks are skipped: tag equals package version,
     the Mac tentacle version-bump guard, and npm.
   - `publish-npm` and `publish-mac-appcast` never run for a dogfood build.
     The `mac-updates` branch is untouched.
4. `prerelease.mjs publish` updates the dogfood release in place. A failed or
   cancelled run never leaves the release without a complete, verified asset
   set:
   1. Upload every new asset as `incoming.<name>`.
   2. Download each one, compare it with the built file, and verify its
      provenance.
   3. Swap names one at a time: `<name>` becomes `previous.<name>`, and
      `incoming.<name>` becomes `<name>`. `appcast-dogfood.xml` goes last.
      Only then do the names the new build no longer has (the previous
      `Kraki-<build>.app.zip`) become `previous.<name>`.
   4. Move the tag to the built commit, then rewrite the title and notes:
      version, commit, build run, and the commits since the previous dogfood
      build.
   5. Delete the `previous.*` copies.

   If a run fails or is cancelled, its "Undo an interrupted dogfood publish"
   step runs `prerelease.mjs recover`, and the next run repeats it first:
   - While `incoming.*` assets remain, the release is rolled back to the
     previous set.
   - Otherwise only the `previous.*` copies are deleted. A name the new
     build dropped that was not moved yet stays until the next publish.
   - Recovery deletes only a name that has a `previous.*` copy, so it never
     removes the only copy of an asset. An asset name that is new in the
     interrupted build (not in the previous set) stays until the next
     publish replaces it.

   The first build creates the release as a draft and publishes it only
   after its assets verify. A draft left by an interrupted first build is
   deleted.

   During the swap, each file is missing for about a second, and a download
   in that moment can fail. Once it is done, the downloaded assets are
   verified again.

A newer dogfood build of the same component cancels an in-progress one
(`release.yml` concurrency group `prerelease-<target>`).

To run it by hand, use **Actions → Prerelease → Run workflow** on `main`
(`component`: `auto` to build only what changed, or `cli`, `mac` or `both` to
build regardless). The workflow refuses any other branch.

```bash
gh workflow run prerelease.yml --ref main -f component=auto
```

## Versions

`N` is the run number of `prerelease.yml`, so it only grows.

| | Formal | Dogfood |
| --- | --- | --- |
| CLI release tag | `v0.38.11` | `dogfood-cli` (always) |
| CLI version | `0.38.11` | `0.39.0-dev.57` |
| Mac release tag | `mac-v0.2.91` | `dogfood-mac` (always) |
| Mac `CFBundleShortVersionString` | `0.2.91` | `0.2.92` |
| Mac `CFBundleVersion` | `93` | `93.57` |

- **CLI**: `Base` is the version in `packages/tentacle/package.json` if it is
  greater than the latest formal `v*`, otherwise the formal version with
  patch + 1. The version is `<Base>-dev.<N>`. In semver it sorts below `Base`,
  so the next formal release is always newer.
- **Mac short version**: the in-repo `MARKETING_VERSION` of `KrakiMac` if it
  is greater than the latest formal `mac-v*`, otherwise the formal version
  with patch + 1.
- **Mac `CFBundleVersion`**: `<formal build>.<N>`, where `formal build` is
  the `CURRENT_PROJECT_VERSION` of the latest formal `mac-v*` tag. Sparkle
  sorts this above the formal build it follows and below every later formal
  build (an integer above it), so Sparkle offers testers the next formal
  release.
- **Built-in tentacle**: the tentacle inside a dogfood Mac build carries the
  CLI dogfood version of the same run. Because that differs from the running
  daemon's version, the app restarts the daemon after installing.
- **Helper bundle versions**: in the tentacle helper bundle and the CLI's
  `Kraki.app`, `CFBundleVersion` keeps only the numeric part of a dogfood
  version (`0.39.0` for `0.39.0-dev.57`). `CFBundleShortVersionString`,
  `KrakiTentacleVersion` and `kraki --version` show it whole.

## Why regular users never get one

| Path | Why a dogfood build is skipped |
| --- | --- |
| `kraki update`, startup hint, phone/remote update (`fetchLatestVersion`) | Asks GitHub's `releases/latest` first. Only formal CLI tags take "latest" (`release.yml`), and a prerelease never does. Falls back to a page of 100 releases, skipping prereleases and tags that do not start with `v`. CLIs up to 0.38.11 read 20 releases; only two dogfood entries ever exist. |
| `install.sh` | `releases/latest`, unless `KRAKI_CHANNEL=dogfood` or `KRAKI_VERSION` is set |
| `install.ps1` | skips prereleases, unless `KRAKI_CHANNEL=dogfood` or `KRAKI_VERSION` is set |
| Web "Download for Mac" (`pickMacDmg`) | skips prereleases and tags that do not start with `mac-v` |
| Kraki for Mac (Sparkle) | the app reads the production appcast on `mac-updates`, written only for `mac-v*` releases. Only a Mac switched to Dogfood in Settings (shown to internal accounts) reads the dogfood feed |
| npm | dogfood builds are never published to npm |
| Windows | out of scope: no Windows dogfood build, and `install.ps1` skips prereleases |

Tests:
- `packages/tentacle/src/__tests__/update.test.ts`
- `packages/arm/web/src/lib/macDownload.test.ts`
- `packages/tentacle/src/__tests__/installer-contract.test.ts`
- `scripts/e2e/windows-installer.test.ps1`
- `scripts/release/prerelease.test.mjs`
- `scripts/release/dogfood-feed.test.mjs`
- `packages/arm/ios/KrakiMacTests/MacUpdateChannelTests.swift`

## Installing a dogfood build (testers)

**CLI** (macOS / Linux): use the normal installer on the dogfood channel. The
download is checksum-verified against the release's `SHA256SUMS.txt` as usual.

```bash
curl -fsSL https://app.kraki.chat/install.sh | KRAKI_CHANNEL=dogfood bash
```

**CLI** (Windows PowerShell):

```powershell
$env:KRAKI_CHANNEL = "dogfood"; irm https://app.kraki.chat/install.ps1 | iex
```

Run it again to get the newest dogfood build. `KRAKI_VERSION=v0.38.11` still
pins a formal release.

The stable download URLs always serve the newest build, for example:
- `https://github.com/corelli18512/kraki/releases/download/dogfood-cli/kraki-cli-linux-x64`
- `https://github.com/corelli18512/kraki/releases/download/dogfood-mac/Kraki.dmg`

`kraki update` never offers a dogfood build. When the next formal release
(for example `0.39.0`) is out, it is newer than `0.39.0-dev.57`, so
`kraki update` and remote updates move the tester back to the formal line.
Until then, `kraki update` reports "already on the latest version".

**Kraki for Mac**: in Kraki, open **Settings › General › Updates** and
choose **Dogfood**.
- **Who sees it**: accounts with `preferences.internal` (as on Web), and any
  Mac that is already on Dogfood, so it can always switch back.
- **What happens**: Kraki checks the dogfood feed right away and offers the
  newest dogfood build. From then on every update check (daily, or **Check
  for Updates…**) uses the dogfood feed, so the Mac follows each new dogfood
  build and each formal release that is newer.
- **The setting**: stored per Mac (`mac.updateChannel` in the app's
  defaults). Production app only; Dev builds have no updater.
- **What changes**: Sparkle replaces `/Applications/Kraki.app` and its
  built-in tentacle; the daemon restarts on the new helper. Sign-in and data
  are kept. The app is Developer ID signed and notarized like a formal
  release.
- **Back to Stable**: choose **Stable**. Sparkle never downgrades: the Mac
  keeps its dogfood build until the next formal release, whose
  `CFBundleVersion` is higher, and then updates as usual. Settings says so.
- **Without the setting** (for example signed out on a non-internal
  account): download
  [`Kraki.dmg`](https://github.com/corelli18512/kraki/releases/download/dogfood-mac/Kraki.dmg),
  open it, and drag Kraki to Applications. That Mac stays on Stable and is
  offered the next formal release. To go back early, install the latest
  formal `Kraki.dmg`.

### Dogfood Sparkle feed

<https://github.com/corelli18512/kraki/releases/download/dogfood-mac/appcast-dogfood.xml>
(`MacUpdateChannel.dogfoodFeedURL`). It lists the newest dogfood build and
the newest formal release, and Sparkle offers whichever is higher:
- **Each dogfood build** writes it in `release.yml` (`Generate dogfood Sparkle
  feed`): the production appcast from `mac-updates` plus this build, the
  newest two kept. The `mac-updates` branch is only read.
- **Each formal Mac release** rewrites it in `publish-mac-appcast` (`Refresh
  the dogfood Sparkle feed`), after the production appcast is pushed: the
  live dogfood feed plus the new release. So a dogfood Mac is never left
  below a formal release. The refresh waits while a dogfood publish is
  swapping assets, then swaps only the feed (`prerelease.mjs feed-replace`).
- **Signing**: `generate_appcast` signs the feed and every item with the
  production Sparkle key (`SPARKLE_ED25519_PRIVATE_KEY`); the app requires
  signed feeds (`SURequireSignedFeed`) and checks them with the shipped
  `SUPublicEDKey`.
- **No mismatched archive**: a dogfood item points at
  `Kraki-<CFBundleVersion>.app.zip`, a name only that build uses. The swap
  adds the new archive before the new feed and removes the old archive
  after it, so a feed never names a missing archive or another build's.
- **Checks**: `scripts/release/dogfood-feed.mjs check` fails the run unless
  the feed is signed, lists the expected item and the newest production item
  unchanged, and every dogfood item names its own archive.

The production appcast never lists a dogfood build: it is written only by
`publish-mac-appcast` for `mac-v*` releases, as before.

## Owner setup

Dogfood builds need no secrets beyond the formal release ones: Apple signing
and notarization, plus the Sparkle key for the dogfood feed (also used by
`publish-mac-appcast` to refresh it).

Permissions:
- `prerelease.yml` uses `GITHUB_TOKEN` with only `contents: read`, plus
  `actions: write` in the job that dispatches `release.yml`.
- `release.yml`'s `publish` job uses its existing `contents: write` to move
  the `dogfood-*` tags and replace assets; `publish-mac-appcast` uses it to
  replace `appcast-dogfood.xml`.

A tag ruleset that restricts updating tags must let GitHub Actions move
`dogfood-cli` and `dogfood-mac`.

To verify a dogfood asset's provenance:

```bash
gh attestation verify kraki-cli-linux-x64 --repo corelli18512/kraki \
  --signer-workflow corelli18512/kraki/.github/workflows/release.yml --source-ref refs/heads/main
```
