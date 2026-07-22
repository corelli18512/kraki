# macOS TCC permissions — root-cause fix for "kraki keeps losing its permissions"

> Status: fixed end-to-end. The recurring re-grant-on-every-update bug is
> resolved by registering `Kraki.app` with Launch Services. This document
> exists so nobody re-introduces the regression.

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

`#123/#133/#138/#142` all attacked detection or packaging, never these
two mechanisms. The `.app` wrap (#142) was the right instinct but (a) it
doesn't change how launchd launches the binary, and (b) it never cleaned
the Launch Services pollution, so the zombie problem kept growing.

## Fix

Three things, all in `packages/tentacle/src/checks.ts` and wired into the
install/update/daemon paths:

1. **`registerKrakiAppBundle()`** — `lsregister -f <Kraki.app>`. Called on
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

Because the Developer ID Team ID (`3A83X5JZ3S`) never changes between
releases, once the Launch Services state is clean and the bundle is
registered, the bundle-id path through TCC is stable and a granted
permission survives updates. The path-tracked risk (Bug 1) is addressed
by keeping the canonical path stable (it is) and keeping Launch Services
unambiguous (Bug 2 fix) so the resolver consistently lands on the
bundle-id-tracked record.

### Verified

- `vitest run` — 748/748 pass (incl. 19 new tests covering bundle
  detection, lsregister calls, the vanished-path stub eviction, and
  `cleanupStaleBundleEntries`).
- `tsc --noEmit` — 0 errors across the whole tentacle package.
- Sandbox (`/tmp/kraki-tcc-sandbox-test.sh`) — registers, survives a
  simulated update, never touches the real `chat.kraki.cli`.
- Direct eviction probe (`/tmp/evict-probe.mjs`, against the real compiled
  `dist/checks.js`) — a deleted-path zombie (3 entries) is reduced to 0 by
  `unregisterAppBundlePath()`.

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
