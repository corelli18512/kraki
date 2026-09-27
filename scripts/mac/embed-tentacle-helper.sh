#!/usr/bin/env bash
# Xcode build phase for KrakiMac: embed the built-in tentacle.
#
# Copies a prebuilt, already-signed "Kraki Tentacle.app" into
#   Kraki.app/Contents/Library/Helpers/
# and writes the SMAppService launch agent plist into
#   Kraki.app/Contents/Library/LaunchAgents/<bundle id>.tentacle.plist
#
# Source of the helper, in order:
#   1. $KRAKI_TENTACLE_HELPER (build setting or environment)
#   2. packages/arm/ios/build/embedded-tentacle/Kraki Tentacle.app
#
# With no helper available the app is built without a built-in tentacle and
# falls back to an external `kraki` CLI at runtime. Release builds that must
# ship it set KRAKI_REQUIRE_TENTACLE=1 so a missing helper fails the build.
set -euo pipefail

HELPER="${KRAKI_TENTACLE_HELPER:-${SRCROOT}/build/embedded-tentacle/Kraki Tentacle.app}"
CONTENTS="${TARGET_BUILD_DIR}/${CONTENTS_FOLDER_PATH}"
DEST_HELPERS="$CONTENTS/Library/Helpers"
DEST_AGENTS="$CONTENTS/Library/LaunchAgents"
LABEL="${PRODUCT_BUNDLE_IDENTIFIER}.tentacle"

rm -rf "$DEST_HELPERS/Kraki Tentacle.app" "$DEST_AGENTS/$LABEL.plist"

if [ ! -x "$HELPER/Contents/MacOS/kraki" ]; then
  if [ "${KRAKI_REQUIRE_TENTACLE:-0}" = "1" ]; then
    echo "error: built-in tentacle helper not found at $HELPER" >&2
    exit 1
  fi
  echo "note: no built-in tentacle helper at $HELPER; building without it"
  exit 0
fi

mkdir -p "$DEST_HELPERS" "$DEST_AGENTS"
ditto "$HELPER" "$DEST_HELPERS/Kraki Tentacle.app"

# KeepAlive: launchd restarts the daemon if it exits for any reason.
# ThrottleInterval bounds a crash loop. AssociatedBundleIdentifiers attributes
# the job to this app in System Settings → Login Items. KRAKI_MANAGED_BY tells
# the worker it runs under the app (login-shell env, no CLI LS upkeep).
cat > "$DEST_AGENTS/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>BundleProgram</key>
    <string>Contents/Library/Helpers/Kraki Tentacle.app/Contents/MacOS/kraki</string>
    <key>ProgramArguments</key>
    <array>
        <string>kraki</string>
        <string>__daemon-worker</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>KRAKI_MANAGED_BY</key>
        <string>kraki-mac</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>AssociatedBundleIdentifiers</key>
    <array>
        <string>${PRODUCT_BUNDLE_IDENTIFIER}</string>
    </array>
</dict>
</plist>
PLIST
plutil -lint "$DEST_AGENTS/$LABEL.plist" >/dev/null

# Version lock: record which tentacle this app ships so it can detect a daemon
# still running an older binary after a Sparkle update.
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$HELPER/Contents/Info.plist")
INFO="$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :KrakiTentacleVersion" "$INFO" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :KrakiTentacleVersion string $VERSION" "$INFO"
echo "Embedded built-in tentacle $VERSION ($LABEL)"
