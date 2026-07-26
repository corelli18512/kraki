# macOS TCC permissions — root-cause fix for "kraki keeps losing its permissions"

> Status: fixed by changing how the daemon is **launched**.
>
> An earlier revision of this document declared the bug "fixed end-to-end by
> registering `Kraki.app` with Launch Services". That was wrong, and it was the
> seventh failed fix. `lsregister -f` makes Launch Services aware that the bundle
> exists **on disk**; it has no effect on the **runtime identity** of a process
> that launchd `execve()`d directly, and runtime identity is what TCC keys on.
> Registration was necessary but never sufficient. See "What was actually
> measured" below — the evidence, rather than the reasoning, is the point.

## Symptom

Every time kraki is updated, macOS "forgets" Full Disk Access (and every
other TCC grant the user toggled): `probeFda()` flips back to `denied` and
the user has to re-add kraki in System Settings → Privacy & Security.

## Root cause (confirmed against the live install)

TCC doesn't store "is this app allowed". It stores "is this **code**
allowed", identified by a **designated requirement (DR)** plus, for
helper tools/daemons launched by **path**, the **path + cdhash**.

Two independent, compounding bugs made kraki's grants break on every
update. Both were verified on the real install:

### Bug 1 — the daemon is launched by **path**, not by bundle id

The launchd agent (`~/Library/LaunchAgents/cloud.corelli.kraki.plist`)
has `ProgramArguments = [ <abs-path>/Kraki.app/Contents/MacOS/kraki,
"__daemon-worker" ]`. launchd `execve()`s the Mach-O **directly**; it does
**not** go through Launch Services / `open`. For a process launched that
way, TCC identifies it by `client_type=1` (absolute path), and after the
macOS 11.4 fix for CVE-2021-30713 it re-validates the binary at that path
against the cdhash stored at grant time. So even though the Developer-ID
DR (`identifier "chat.kraki.cli" and … certificate leaf[subject.OU] =
"3A83X5JZ3S"`) is itself cdhash-free and *would* survive an update under
bundle-id tracking, a **path-tracked** grant does not survive a binary
replacement at the same path.

This is exactly the "Full Disk Access breaks for helper tools after
11.4" class documented by Michael Tsai / Jerry Krinock: a background
helper launched by path loses inherited TCC rights when the on-disk
binary changes.

### Bug 2 — Launch Services was polluted with zombie `chat.kraki.cli` entries

`update.ts` extracted each update into `$(TMPDIR)/kraki-app-update/Kraki.app`
and then moved it into place. That temp extraction — plus years of Xcode
builds, test extractions, and acceptance runs — caused Launch Services to
accumulate **dozens** of `chat.kraki.cli` entries at paths that no longer
exist (verified: `/private/tmp/kraki-local-update-0.29.16/…`,
`/private/tmp/kraki-0.30.0-acceptance/…`, ~69 total). When the daemon is
launched by path, TCC's responsible-bundle resolver has to pick which of
those entries the running process "is". With many conflicting / vanished
entries, resolution is unstable and TCC re-prompts.

Worse, `lsregister -u <path>` **fails on a path that no longer exists**
(error `-10814`, "failed to scan"), so the zombies were effectively
permanent — until now.

### Why the prior fixes kept relapsing

`#123/#133/#138/#142` all attacked detection or packaging, never these two
mechanisms. The `.app` wrap (#142) was the right instinct but (a) it doesn't
change how launchd launches the binary, and (b) it never cleaned the Launch
Services pollution, so the zombie problem kept growing.

`#182` then fixed Bug 2 properly — the zombie sweeper works and should stay. But
it only *argued around* Bug 1, claiming the path-tracking risk was "addressed by
keeping the canonical path stable and keeping Launch Services unambiguous". It
is not. Keeping the path stable is precisely the case that breaks: TCC stores
path **plus cdhash**, and every update rewrites the cdhash at that stable path.

The deeper reason this recurred seven times is that **nothing ever measured the
daemon's runtime identity**. Bundle registration and LS cleanliness are both easy
to observe and both looked correct, so each fix appeared to work until a user
updated again.

## What was actually measured

Run directly against the live install and a set of throwaway signed bundles on
macOS 26.5. `lsappinfo info -only bundleid <pid>` and
`NSRunningApplication(processIdentifier:)` agree in every case.

| Bundle `Info.plist` | Launched by | Launch Services identity |
|---|---|---|
| `LSBackgroundOnly` + `LSUIElement` (kraki's exact config) | `execve` of `Contents/MacOS/…` | **none** |
| `LSUIElement` only | `execve` of `Contents/MacOS/…` | **none** |
| `LSBackgroundOnly` + `LSUIElement` | `open` | bundle id resolves |
| `LSUIElement` only | `open` | bundle id resolves |
| — | launchd job running `open -W -n -a` | bundle id resolves |

The live kraki daemon reported `"CFBundleIdentifier"=[ NULL ]`, i.e. no bundle
identity at all — so TCC had nothing to key on but the absolute path.

Three conclusions follow, and they are what the fix rests on:

1. **The launch method decides everything.** `Info.plist` flags are irrelevant;
   `LSBackgroundOnly` is not the culprit and removing it changes nothing.
2. **A plain non-AppKit CLI binary does get a full bundle identity** when started
   through LaunchServices. Being a Node SEA binary is not an obstacle.
3. **`lsregister -f` cannot fix this**, because it only describes the bundle on
   disk and never touches the identity of a running process.

Independently confirmed that grants do survive an update once the identity is
right: a Developer-ID-signed bundle launched via LaunchServices kept Screen
Recording, Accessibility, Input Monitoring and Microphone across a version bump
that changed its cdhash.

## Fix

### The load-bearing change — launch through LaunchServices

`buildLaunchdPlist()` in `packages/tentacle/src/daemon.ts` now emits, for any
bundled install:

```
/usr/bin/open -W -n -a <Kraki.app>
  --stdout <bootstrap.log> --stderr <bootstrap.log>
  --env K=V …
  --args __daemon-worker
```

instead of `execve`ing `Kraki.app/Contents/MacOS/kraki` directly. The daemon now
has a real bundle identity, so TCC stores the grant against `chat.kraki.cli` and
its cdhash-free Designated Requirement, which survives every update.

Details that are load-bearing, each verified rather than assumed:

- **`-W`** blocks for the app's lifetime, so launchd still supervises the daemon.
  Without it `open` returns immediately and launchd loses the process entirely.
- **`KeepAlive: true`**, not `SuccessfulExit: false`. `open -W` exits **0 even
  when the app it waits on is SIGKILLed**, so the old exit-code condition would
  never fire and a crashed daemon would stay dead. `ThrottleInterval: 10` keeps
  an unlaunchable bundle from spinning.
- **`--env`** is required: an app started through LaunchServices inherits the
  launchd *session* environment, not the environment of whoever called `open`.
  Without it the daemon silently loses `PATH`, proxy settings and tokens.
- **`--stdout` / `--stderr`** for the same reason — the launchd job's
  `StandardOutPath` now captures `open` itself, not the daemon.
- **`--args` must come last**; `open` treats everything after it as app `argv`.
  Verified the daemon receives a clean `argv[1] == "__daemon-worker"` with no
  `-psn_…` argument injected.
- **`stopDaemon()` now unloads the launchd job *before* signalling the daemon.**
  With `KeepAlive: true`, killing first lets launchd resurrect the daemon in the
  window before the job is unloaded, and `kraki stop` appears to do nothing.
- Non-bundled installs keep the old direct-`execve` behaviour and its original
  `SuccessfulExit: false` semantics, where exit status is still meaningful.

`buildLaunchdPlist()` is exported and pure specifically so the launch mechanism
is asserted in CI (`src/__tests__/daemon-launch-tcc.test.ts`, 13 tests). That is
the actual regression guard: this bug relapsed six times because nothing ever
tested *how* the daemon was launched.

### Supporting changes (necessary, not sufficient)

Three things in `packages/tentacle/src/checks.ts`, wired into the
install/update/daemon paths. These keep System Settings showing one unambiguous
"Kraki" entry; they do **not** by themselves preserve grants:

1. **`registerKrakiAppBundle(path?)`** — `lsregister -f <Kraki.app>`. Called on
   install, after every self-update, and on every daemon start, so the
   canonical bundle-id binding Launch Services needs is always current.

2. **`unregisterAppBundlePath(path)`** — evicts a Launch Services entry.
   Crucially it handles the previously-impossible case of a **vanished**
   path: it recreates a 3-file stub bundle at the dead path, runs
   `lsregister -u`, then removes the stub. (Direct `lsregister -u` on a
   gone path returns `-10814`; the stub is the only non-destructive way to
   evict an orphan.) Verified end-to-end against real Launch Services: a
   throwaway bundle registered → path deleted → 3 zombie entries left →
   `unregisterAppBundlePath()` → **0 entries**.

3. **`cleanupStaleBundleEntries()`** — parses `lsregister -dump`, finds
   every `chat.kraki.cli` entry that is either (a) a `/private/tmp` /
   `$TMPDIR` throwaway, or (b) a path that no longer exists, and evicts it
   via #2 while always preserving the canonical install path. Runs on
   every install, every self-update, and every daemon start, so it
   one-shot heals every already-installed machine too.

`update.ts` also calls `unregisterAppBundlePath()` on the temp extraction
*immediately after untar*, before it can become a zombie.

Wiring:

| Where | Why |
|-------|-----|
| `install.sh` `install_app_bundle()` | register on first install |
| `packages/arm/web/public/install.sh` | same, toolbar-served installer |
| `update.ts` `updateViaAppBundle()` | unregister temp extract; re-register; sweep zombies |
| `daemon-worker.ts` `startWorker()` | register + sweep on every daemon start (self-heal) |
| `cli.ts` `cmdPermissions(--clean)` + `cmdDoctor()` | user-driven / observable |

The Developer ID Team ID (`3A83X5JZ3S`) never changes between releases, so the
Designated Requirement is stable and cdhash-free. Combined with a daemon that
actually has a bundle identity, a granted permission now survives updates.

Two further corrections shipped with this change:

- `registerKrakiAppBundle()` now takes an explicit path, and `update.ts` passes
  the **new** `targetAppDir`. The no-argument form derived the bundle from the
  running process's `execPath`, which at that point is the old bundle just
  renamed to `.bak` — and in the standalone-to-bundle migration it returned
  `null`, so the freshly installed bundle was never registered at all.
- `unregisterAppBundlePath()` now only fabricates its eviction stub at a path
  that is **completely absent**. It previously wrote a stub into any directory
  lacking `Contents/Info.plist` and then `rmSync`'d the whole tree — which would
  delete a half-extracted update, or an unrelated directory that merely shared
  the name. An uncollected Launch Services record is recoverable; a deleted
  directory is not.

### Diagnosing it next time

`kraki doctor` now reports `tcc.identity`:

```json
{ "bundled": true, "bundlePath": "…/Kraki.app",
  "daemonPid": 6856, "daemonBundleId": null, "healthy": false }
```

`daemonBundleId: null` with `bundled: true` is the exact broken state — a
correctly signed, correctly registered bundle whose daemon was nonetheless
started by absolute path. That single field is what was missing for seven
attempts. When healthy it reads `"daemonBundleId": "chat.kraki.cli"`.

### Verified

- `vitest run` — 792/792 pass, including 13 new tests in
  `src/__tests__/daemon-launch-tcc.test.ts` asserting the launch mechanism
  itself: `open` as `argv[0]`, `-W`, `-n`, `-a <bundle>`, `--args` last,
  `--env`/`--stdout`/`--stderr` forwarding, `KeepAlive: true`, and the
  direct-`execve` fallback for non-bundled installs.
- `tsc --noEmit` — 0 errors across the whole tentacle package.
- Launch identity measured live on macOS 26.5 across four bundle/launch
  combinations plus a real launchd job (see "What was actually measured").
- End-to-end under real launchd: a job running `open -W -n -a <bundle>` produced
  a process with a resolved bundle id, stayed supervised, and was **restarted
  ~1s after `kill -9` with its identity intact**.
- Grant survival across a cdhash-changing update confirmed on a Developer-ID
  signed bundle launched through LaunchServices.

Not verified here, and the one thing left to confirm on a real install: that a
freshly granted Full Disk Access on the updated kraki survives the *next* real
release. The mechanism is proven; the production round-trip needs one user grant.

## Granting the permissions (user)

TCC.db is SIP-protected, so no process can grant itself anything. The user
must toggle each switch once. After this fix, **once is enough forever**.

```
kraki permissions --open
```

opens every relevant pane in System Settings:

- **Full Disk Access** — read project files, TCC db, Mail/Safari data
- **Accessibility** — synthesize input / drive UI via the Accessibility API
- **Input Monitoring** — observe global key events
- **Screen Recording** — capture screen contents
- **Automation** — send AppleEvents to other apps

The setup wizard (`kraki`) runs this step automatically and polls FDA as
its "done" signal (FDA is the only service with a reliable non-intrusive
probe — the others report `unknown` until exercised at runtime).

## CLI surface

```
kraki permissions            # JSON: bundle registration + per-service status
kraki permissions --open     # open every TCC pane
kraki doctor                 # now includes a `tcc` block (bundled/registered/path)
kraki fda [--json|--watch]   # unchanged, retained for compatibility
```

## Guard rails for future changes

- **Never** change `APPLE_SIGNING_IDENTITY` / Team ID between releases. TCC
  bundle-id tracking is keyed on the DR, which includes the Team ID. A new
  Team ID resets every grant.
- **Never** strip the `.app` wrapping. A raw Mach-O executed directly has
  no bundle identity to track.
- **Never** point the launchd job back at `Contents/MacOS/kraki`. That single
  change silently reintroduces the entire bug — the daemon keeps running, the
  bundle stays signed and registered, and grants quietly stop surviving updates.
  `daemon-launch-tcc.test.ts` fails if you do; do not "fix" that test.
- **Never** launch the daemon through the `~/.local/bin/kraki` symlink either.
  It has the same effect: no bundle identity, path-tracked grant. (`install.sh`
  and the web installer still do this for their initial post-install start — it
  is the remaining known gap, tracked below.)
- Keep the notarization ticket **stapled** and staple *before* building the
  distribution tarball. An unstapled app needs a successful online Gatekeeper
  check on every launch; if Gatekeeper refuses to launch it, its TCC grants are
  irrelevant.
- If you ship a second bundle (e.g. the Tauri toolbar,
  `cloud.corelli.kraki.toolbar`), register **that** bundle with
  `lsregister` too — its TCC grants are tracked under its own bundle id.
- `registerKrakiAppBundle()` must stay best-effort and never throw: a
  failure (SSV/CSM, missing `lsregister`) is recoverable on next launch.

## History (why this took six tries)

| Commit | What it tried | Why it wasn't enough |
|--------|---------------|----------------------|
| `af5e5a7f` | TCC warmup during setup | warmed a single path, still cdhash-tracked |
| `3489cfe3` | App Data (FileProvider) probe | added a second path, same tracking problem |
| `ce0d5ca1` (#123) | collapse to "require FDA only" | cleaner, still lost on update |
| `3efb194d` (#133) | robust multi-path FDA probe | fixed *detection*, not *persistence* |
| `ad7b9c2d` (#138) | probe FDA before binary replace | worked around the post-replace probe, not the grant loss |
| `9da93153` (#142) | wrap CLI in `.app` to "preserve FDA" | correct theory — but never registered the bundle with Launch Services, so TCC still used cdhash |
| `12ddf3c2` (#182) | `lsregister -f` + zombie eviction + real app icon | fixed Bug 2 for good, but only argued around Bug 1; the daemon was still `execve`'d by path, so it still had no bundle identity |
| *this change* | launch the daemon via `open -W -n -a <bundle>` | gives the daemon a real Launch Services identity — the thing every previous fix left untouched |

### Installers

Both `install.sh` and `packages/arm/web/public/install.sh` previously started
the first daemon with `nohup "${INSTALL_DIR}/kraki" __daemon-worker` — through
the symlink, so that very first daemon had no bundle identity either. If the
user granted Full Disk Access to *that* process, the grant was path-tracked from
the outset and died on the next update.

Both now launch the bundle through LaunchServices on macOS:

```sh
open -n -a "$HOME/.local/share/kraki/Kraki.app" \
  --stdout "$BOOTSTRAP_LOG" --stderr "$BOOTSTRAP_LOG" \
  --env "PATH=$PATH" --env "HOME=$HOME" \
  --args __daemon-worker
```

with the original `nohup` retained for non-macOS and for the non-bundled
fallback. Because `open` returns as soon as the app is launched, the liveness
check matches on process name instead of a PID the shell never owned.

Still open, and not a TCC issue: the two installers disagree on `INSTALL_DIR`
(`~/.local/bin` vs `/usr/local/bin`), so the symlink location differs by install
channel. Worth unifying separately.
| **this change** | **`lsregister` on install + after every update** | **closes the gap #142 left open** |

## The trigger we actually hit on the live install

Diagnosis of the real machine narrowed the recurrence to a specific,
reproducible misconfiguration — not a vague macOS quirk:

- The CLI's `Kraki.app` was shipped with **no icon and no `CFBundleIconFile`**,
  so every macOS surface (System Settings, Finder, Dock) showed it as a generic
  binary — visually identical to the raw Mach-O at `~/.local/bin/kraki`.
- A **second** app, the native SwiftUI Mac app (`chat.kraki.mac`, with a proper
  icon), also appeared in System Settings as "Kraki".
- In the Full Disk Access list the user therefore saw *two* "Kraki" entries and
  granted the toggle to the wrong one (the `chat.kraki.mac` entry, bundle id
  mismatched → useless to the CLI daemon). The CLI itself, when launched from
  the `~/.local/bin/kraki` symlink, got authorized as a raw **path**
  (`client_type=1`) because TCC couldn't resolve it to the bundle — and a
  path-tracked grant dies on every binary update.

So the fix set is: (1) ship a real icon so the CLI bundle is visually distinct
(this change), (2) keep Launch Services clean and the bundle registered (the
`lsregister` work), (3) on the user side, authorize the `chat.kraki.cli`
bundle specifically — identifiable now by its icon — and stop launching the
daemon via the raw symlink.
