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
# Volume icon = the app's icon.
ICON_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$APP/Contents/Info.plist" 2>/dev/null || true)"
ICON="$APP/Contents/Resources/${ICON_NAME%.icns}.icns"
if [ -n "$ICON_NAME" ] && [ -f "$ICON" ]; then ARGS+=(-D "icon=$ICON"); fi

rm -f "$OUT"
dmgbuild "${ARGS[@]}" "Kraki" "$OUT"
ls -lh "$OUT"
