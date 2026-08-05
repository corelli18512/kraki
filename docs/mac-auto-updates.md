# macOS Auto Updates

Kraki's signed production macOS GUI uses Sparkle 2 for in-app updates.

## Bootstrap

`0.2.0` predates Sparkle, so it cannot update itself. The first release containing this updater is `0.2.1` and must be installed once through the existing GitHub Release download. Every later `mac-v*` release can then be installed from inside the app.

## User behavior

- Production builds check the stable appcast after launch and then on Sparkle's 24-hour schedule.
- `Kraki > Check for Updates...` starts an explicit check and shows Sparkle's standard update UI.
- Updates are downloaded only after the user chooses to install them. The app is then relaunched by Sparkle.
- Debug and `Kraki Dev.app` builds do not start Sparkle and cannot consume the production feed.

The current feed is:

`https://raw.githubusercontent.com/corelli18512/kraki/mac-updates/appcast.xml`

The `mac-updates` branch contains only the generated appcast. Release archives remain GitHub Release assets.

## Release flow

A `mac-v*` tag runs the normal signed universal Mac archive pipeline. The archive is Developer ID signed, notarized, stapled, and uploaded as both the existing `.tar.gz` distribution asset and a `Kraki.app.zip` Sparkle update asset.

After the GitHub Release is created, a macOS release job downloads `Kraki.app.zip`, runs Sparkle's `generate_appcast`, signs the feed with the Ed25519 key, and pushes the updated `appcast.xml` to `mac-updates`.

The public Sparkle key is embedded in the production `Info.plist` as `SUPublicEDKey`. The matching private key is stored only in the GitHub Actions secret `SPARKLE_ED25519_PRIVATE_KEY`. It must never be committed, printed in logs, or placed in a release asset.

## Safety boundaries

Sparkle verifies the Ed25519 update signature before installation. Apple Developer ID signing, notarization, and Gatekeeper validation remain required for every archive. The GUI updater does not update the separate Tentacle daemon; daemon compatibility and upgrade sequencing remain a separate release concern.

The appcast publisher is serialized with the `mac-updates-appcast` workflow concurrency group so two Mac tags cannot overwrite the feed concurrently.
