# Dogfood prereleases (CLI and Kraki for Mac)

Every merge to `main` that changes the CLI or Kraki for Mac publishes a
**prerelease** of that component for the owner and internal testers. Regular
users never receive one through any automatic path. Formal releases stay
manual and unchanged (push a `v*` / `mac-v*` / `head-v*` tag, or run
`release.yml` with `mode=publish`).

## How it runs

1. `CI` completes successfully for a push to `main`.
2. `.github/workflows/prerelease.yml` checks out the commit CI tested and runs
   `node scripts/release/prerelease.mjs plan`. For each component it diffs
   that commit against the component's previous published prerelease (or, if
   there is none, its latest formal tag) and keeps only files the component
   ships:
   - **CLI**: `packages/tentacle`, `packages/protocol`, `packages/pulse`,
     `packages/crypto` (without their Swift packages) and
     `scripts/release/build-info.mjs`.
   - **Mac**: everything the CLI includes (the app embeds the tentacle), the
     Swift packages, `packages/arm/ios` except the iOS-only targets
     (`KrakiNotification`, `KrakiTests`, `KrakiUITests`, `KrakiVoiceUITests`,
     `KrakiMacTests`, `ExportOptions-AppStore.plist`), and `scripts/mac`.
   - Tests (`__tests__/`, `*.test.*`) and Markdown never count.

   Nothing changed: no prerelease.
3. For each changed component it creates a `dev-cli-*` / `dev-mac-*` tag on
   that commit and dispatches `release.yml` on the tag with
   `mode=prerelease`. The same jobs as a formal release build, sign,
   notarize, staple, attest and verify the artifacts. Only the formal-only
   checks are skipped (tag equals package version, the Mac tentacle
   version-bump guard, npm). `publish-npm` and `publish-mac-appcast` never run
   for a prerelease.
4. The release is created with `--prerelease --latest=false` and a changelog
   of the commits since the previous prerelease or formal tag.
5. Afterwards only the newest 10 prereleases per component are kept. Older
   ones are deleted together with their tags. Tags whose build a newer commit
   cancelled are deleted too.

A newer prerelease of the same component cancels an in-progress build
(`release.yml` concurrency group `prerelease-<target>`).

To run it by hand, use **Actions → Prerelease → Run workflow**
(`component`: `auto` to build only what changed, or `cli`, `mac` or `both` to
build regardless):

```bash
gh workflow run prerelease.yml --ref main -f component=auto
```

## Versions

`N` is the run number of `prerelease.yml`, so it only grows.

| | Formal | Prerelease |
| --- | --- | --- |
| CLI tag | `v0.38.11` | `dev-cli-0.38.12-dev.57` |
| CLI version | `0.38.11` | `0.38.12-dev.57` |
| Mac tag | `mac-v0.2.91` | `dev-mac-0.2.92-dev.57` |
| Mac `CFBundleShortVersionString` | `0.2.91` | `0.2.92` |
| Mac `CFBundleVersion` | `93` | `93.57` |

- **CLI**: `Base` is `packages/tentacle/package.json` if that is greater than
  the latest formal `v*`, otherwise the formal version with patch + 1. The
  version is `<Base>-dev.<N>`. In semver it sorts below `Base`, so the next
  formal release is always newer.
- **Mac**: the short version is the in-repo `MARKETING_VERSION` of `KrakiMac`
  if greater than the latest formal `mac-v*`, otherwise the formal version with
  patch + 1. `CFBundleVersion` is `<formal build>.<N>`, where `formal build` is
  the `CURRENT_PROJECT_VERSION` of the latest formal `mac-v*` tag. Sparkle
  sorts this above the formal build it follows and below every later formal
  build (an integer above it), so Sparkle offers testers the next formal
  release.
- The tentacle inside a Mac prerelease carries the CLI prerelease version of
  the same run. Because the version differs from the running daemon's, the
  app restarts the daemon after installing.

## Why regular users never get one

| Path | Why a prerelease is skipped |
| --- | --- |
| `kraki update`, startup hint, phone/remote update (`fetchLatestVersion`) | skips `prerelease` releases and tags that do not start with `v` |
| `install.sh` | `releases/latest`, which GitHub never assigns to a prerelease |
| `install.ps1` | skips `prerelease` releases |
| Web "Download for Mac" (`pickMacDmg`) | skips `prerelease` releases and tags that do not start with `mac-v` |
| Kraki for Mac (Sparkle) | the appcast on `mac-updates` is written only for `mac-v*` releases |
| npm | prereleases are never published to npm |
| Windows | out of scope: no Windows prerelease, and `install.ps1` skips prereleases |

The CLI updater and the web Mac download read a full page of 100 releases, so
the up to 20 prereleases kept (10 per component) cannot push the newest formal
release off the page they read. Tests:
`packages/tentacle/src/__tests__/update.test.ts`,
`packages/arm/web/src/lib/macDownload.test.ts`,
`packages/tentacle/src/__tests__/installer-contract.test.ts`.

## Installing a prerelease (testers)

Prereleases are listed at
<https://github.com/corelli18512/kraki/releases> (marked *Pre-release*).

**CLI** (macOS / Linux): pass the tag to the normal installer. The download is
checksum-verified as usual.

```bash
curl -fsSL https://app.kraki.chat/install.sh | KRAKI_VERSION=dev-cli-0.38.12-dev.57 bash
```

**CLI** (Windows PowerShell):

```powershell
$env:KRAKI_VERSION = "dev-cli-0.38.12-dev.57"; irm https://app.kraki.chat/install.ps1 | iex
```

`kraki update` never offers a prerelease. When the next formal release
(`0.38.12`) is out, it is newer than `0.38.12-dev.57`, so `kraki update` and
remote updates move the tester back to the formal line. Until then
`kraki update` reports "already on the latest version".

**Kraki for Mac**: download `Kraki.dmg` from the prerelease page, open it and
drag Kraki to Applications. This replaces `/Applications/Kraki.app`; sign-in and
data are kept. The app is Developer ID signed and notarized like a formal
release. Sparkle offers the next formal release when it is published,
because its `CFBundleVersion` is higher. To go back earlier, install the
latest formal `Kraki.dmg`.

## Owner setup

Prereleases need no secrets beyond the formal release ones (Apple signing and
notarization). `prerelease.yml` uses `GITHUB_TOKEN` with `contents: write`
(create tags) and `actions: write` (dispatch `release.yml`). A tag
ruleset that restricts creating `dev-*` tags must allow GitHub Actions.
