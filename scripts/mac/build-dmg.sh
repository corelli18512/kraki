#!/usr/bin/env bash
# Build Kraki.dmg: Kraki.app next to an Applications alias on a background that
# says "Drag Kraki to Applications". Uses dmgbuild, which writes the Finder
# layout (.DS_Store) directly — no Finder scripting, so it works headless in CI.
#
# Usage: scripts/mac/build-dmg.sh /path/to/Kraki.app /path/to/Kraki.dmg
set -euo pipefail

APP="${1:?usage: build-dmg.sh Kraki.app out.dmg}"
OUT="${2:?usage: build-dmg.sh Kraki.app out.dmg}"
HERE="$(cd "$(dirname "$0")" && pwd)"

command -v dmgbuild >/dev/null || { echo "dmgbuild not found (pip install dmgbuild)" >&2; exit 1; }

ARGS=(-s "$HERE/dmg/settings.py" -D "app=$APP" -D "background=$HERE/dmg/background.png")
# Volume icon = the app's icon at every size. The icns Xcode compiles into the
# app stops at 256 px (Finder reads larger sizes from Assets.car), which looks
# blurry as a volume icon, so build a full icns from the AppIcon set instead.
ICONSET_SRC="$HERE/../../packages/arm/ios/Kraki/Resources/Assets.xcassets/AppIcon.appiconset"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
ICON="$WORK/Kraki.icns"
if [ -d "$ICONSET_SRC" ]; then
  mkdir -p "$WORK/Kraki.iconset"
  for s in 16 32 128 256 512; do
    cp "$ICONSET_SRC/icon_${s}.png" "$WORK/Kraki.iconset/icon_${s}x${s}.png"
    cp "$ICONSET_SRC/icon_${s}@2x.png" "$WORK/Kraki.iconset/icon_${s}x${s}@2x.png"
  done
  iconutil -c icns -o "$ICON" "$WORK/Kraki.iconset"
else
  ICON_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$APP/Contents/Info.plist" 2>/dev/null || true)"
  ICON="$APP/Contents/Resources/${ICON_NAME%.icns}.icns"
fi
[ -f "$ICON" ] && ARGS+=(-D "icon=$ICON")

rm -f "$OUT"
dmgbuild "${ARGS[@]}" "Kraki" "$OUT"

# Also give the .dmg file itself the Kraki icon (Finder shows it for local
# copies). Browsers drop this on download, so a downloaded Kraki.dmg still
# shows the generic disk-image icon until it is opened — true of every DMG.
if [ -f "$ICON" ]; then
  swift - "$ICON" "$OUT" <<'SWIFT' || echo "warning: could not set the .dmg file icon" >&2
import AppKit
let a = CommandLine.arguments
guard let image = NSImage(contentsOfFile: a[1]), NSWorkspace.shared.setIcon(image, forFile: a[2]) else { exit(1) }
SWIFT
fi
ls -lh "$OUT"
