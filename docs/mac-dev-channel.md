# macOS Dev channel

The local macOS GUI uses a fixed app identity and install path that are separate
from the notarized Prod app.

| Channel | Install path | Bundle ID | Signing |
| --- | --- | --- | --- |
| Prod | `/Applications/Kraki.app` | `chat.kraki.mac` | Developer ID |
| Dev | `/Applications/Kraki Dev.app` | `chat.kraki.mac.dev` | Apple Development |

The Dev app also uses its own `UserDefaults` domain, Keychain tags, SQLite
folder (`~/Library/Application Support/Kraki Dev`), attachment cache, and icon
with a red `DEV` badge. Unless a local-relay environment override is explicitly
set in an Xcode launch, the installed Dev channel reuses the CLI login and
connects to the production relay.

Prod and Dev share only the machine-local UI file
`~/Library/Application Support/Kraki/config/mac-local.json`. It contains the
schema version, main window width/height, and UI zoom. It is mode `0600` and is
updated atomically under a file lock. Credentials, Session selection, window
position, permissions, and caches are never stored there. Theme is a remote
Head preference (`user.preferences.theme`), with the per-app defaults used only
as an offline cache; it is intentionally not part of `mac-local.json`.

## Build and install

From the repository root:

```bash
pnpm dev:mac
```

This command:

1. builds `KrakiMac` Debug in dedicated DerivedData;
2. verifies `chat.kraki.mac.dev`, the `Kraki (Dev)` name, `DevAppIcon`, Team ID,
   and Apple Development signature;
3. terminates only running `Kraki (Dev)` processes;
4. atomically updates `/Applications/Kraki Dev.app` with rollback support;
5. registers the fixed app with LaunchServices and starts it;
6. verifies that the Prod binary hash and PID did not change.

The destination is hard-coded. The installer refuses unexpected bundle IDs,
signatures, names, icons, and executable names; it never accepts a path that
could target `/Applications/Kraki.app`.

## Microphone permission

Normal rebuilds preserve the existing Dev microphone decision. If it was denied,
run this once:

```bash
pnpm dev:mac:reset-microphone
```

After the app restarts, click its microphone and choose **Allow** in the macOS
prompt. The reset targets only `chat.kraki.mac.dev`; Prod's microphone decision
is not changed.

Changing the Apple Development signing certificate changes the TCC code
requirement and may require one new permission prompt.
