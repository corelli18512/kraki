# Built-in tentacle in Kraki for Mac

Kraki for Mac ships its own tentacle. A new user downloads `Kraki.dmg`, drags Kraki to Applications, signs in with GitHub inside the app and grants Full Disk Access once. No Terminal, no CLI.

## Layout

```
Kraki.app/Contents/Library/Helpers/Kraki Tentacle.app      tentacle SEA (universal), bundle id chat.kraki.mac.tentacle
Kraki.app/Contents/Library/LaunchAgents/chat.kraki.mac.tentacle.plist
Kraki.app/Contents/Info.plist → KrakiTentacleVersion        tentacle version shipped in this app
```

`scripts/mac/build-tentacle-helper.sh` builds the helper (lipo of the native SEA and the cross-built slice from `packages/tentacle/scripts/build-sea-darwin-cross.mjs`); the KrakiMac post-build phase `scripts/mac/embed-tentacle-helper.sh` copies it in and writes the launch agent. Local builds without a staged helper simply build without it and fall back to an external CLI. Debug builds use an embedded helper only with `KRAKI_MAC_ALLOW_BUILTIN_TENTACLE=1`, because they would share `~/.kraki` with a production daemon.

## Supervision

The app registers the launch agent with `SMAppService.agent(plistName:)`. launchd runs the helper executable directly (`BundleProgram`) with `KeepAlive`, independent of the app. `KRAKI_MANAGED_BY=kraki-mac` tells the worker to resolve the user's login-shell environment (launchd's PATH does not contain Homebrew, nvm, …) and to skip the standalone CLI's Launch Services upkeep.

Verified on a clean macOS VM with a notarized build:

- TCC attributes the daemon and every process it spawns to the outer app (`chat.kraki.mac`). Full Disk Access is granted once to "Kraki" and survives updates; the app appears in the FDA list automatically once the daemon has probed a protected path.
- Login Items shows "Kraki" with its icon (the CLI's `open`-based job shows "open — unidentified developer").
- The registration survives reboot and in-place replacement of the app.
- Registering from a translocated app (opened from Downloads without moving it) works until the next reboot, then the job points at a vanished path. The app refuses to start the service unless it runs from a stable location; the DMG's Applications alias is the intended install path. Moving with `mv` does not end translocation, a Finder move does.

## Ownership

`~/.kraki` (config, login, device id, sessions) is shared with the standalone CLI. Only one owner may supervise a daemon, otherwise two daemons share one device id and the relay drops messages. The Mac app writes `~/.kraki/managed-by.json` before registering; while it exists the CLI:

- the start, stop and update commands and interactive setup refuse and point to the app,
- the restart command runs `launchctl kickstart -k` on the app's job,
- status, logs, connect and doctor work as usual.

Mode selection in the app (`TentacleMode.resolve`): an explicit choice in Settings → Tentacle wins; the ownership marker means built-in; an existing CLI launchd job keeps the CLI in charge until the user switches; everyone else gets the built-in tentacle. Switching to built-in stops the CLI's daemon first; switching back unregisters the app's job and removes the marker.

## Releases

The Mac app is version-locked to the tentacle of its commit (`KrakiTentacleVersion`, verified in the release job). **Every tentacle release that should reach Mac app users needs a Mac release as well**; conversely a Mac release ships whatever tentacle is on its commit.

`release.yml` → `build-mac-gui` builds the helper, archives with `KRAKI_REQUIRE_TENTACLE=1`, verifies the helper and produces `Kraki.dmg` in addition to the Sparkle zip and tarball. The DMG is built by `scripts/mac/build-dmg.sh` with `dmgbuild` (fixed icon layout plus a "Drag Kraki to Applications" background; regenerate the background with `scripts/mac/dmg/make-background.py`). `workflow_dispatch` with `mode=dry-run target=mac notarize=true` produces a notarized build for clean-VM testing without publishing anything.
