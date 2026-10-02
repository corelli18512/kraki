#!/usr/bin/env bash
# Build the helper "Kraki.app" — the tentacle SEA binary wrapped as the helper
# bundle that Kraki for Mac embeds at Contents/Library/Helpers/Kraki.app.
#
# Users never see "tentacle": macOS shows this bundle's name and icon in
# privacy prompts that the daemon's own work triggers (Screen Recording is
# attributed to the helper, not to the enclosing app), so it is named "Kraki"
# and carries the Mac app's exact icon. Only the bundle id says "tentacle";
# keep it stable, TCC grants are recorded against it.
#
# Usage:
#   scripts/mac/build-tentacle-helper.sh \
#     --binary <kraki SEA arm64> [--binary <kraki SEA x86_64>] \
#     --version <tentacle version> --out <dir> [--sign "<identity>"]
#
# Multiple --binary arguments are merged into one universal executable with
# lipo (each slice keeps its own NODE_SEA segment). Without --sign the bundle is
# ad-hoc signed, which is enough for local builds but not for distribution.
#
# The bundle id deliberately differs from the standalone CLI (chat.kraki.cli):
# both may be installed side by side, and the CLI sweeps Launch Services
# records for its own id. Most TCC grants (Full Disk Access, folders) are
# attributed to the enclosing Kraki for Mac app; Screen Recording is
# attributed to this bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BINARIES=()
VERSION=""
OUT=""
IDENTITY="-"

while [ $# -gt 0 ]; do
  case "$1" in
    --binary) BINARIES+=("$2"); shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --sign) IDENTITY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ ${#BINARIES[@]} -gt 0 ] || { echo "--binary is required" >&2; exit 2; }
[ -n "$VERSION" ] || VERSION=$(node -p "require('$ROOT/packages/tentacle/package.json').version")
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }

APP="$OUT/Kraki.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [ ${#BINARIES[@]} -gt 1 ]; then
  THIN=()
  for b in "${BINARIES[@]}"; do
    t="$(mktemp -d)/$(basename "$b")"
    cp "$b" "$t"
    codesign --remove-signature "$t" 2>/dev/null || true
    THIN+=("$t")
  done
  lipo -create "${THIN[@]}" -output "$APP/Contents/MacOS/kraki"
else
  cp "${BINARIES[0]}" "$APP/Contents/MacOS/kraki"
  codesign --remove-signature "$APP/Contents/MacOS/kraki" 2>/dev/null || true
fi
chmod 755 "$APP/Contents/MacOS/kraki"

# The Mac app's own icon (same PNGs as its asset catalog), so prompts show
# the familiar Kraki icon.
ICON_SRC="$ROOT/packages/arm/ios/Kraki/Resources/Assets.xcassets/AppIcon.appiconset"
ICONSET="$(mktemp -d)/app.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  cp "$ICON_SRC/icon_${size}.png" "$ICONSET/icon_${size}x${size}.png"
  cp "$ICON_SRC/icon_${size}@2x.png" "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/app.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>chat.kraki.mac.tentacle</string>
    <key>CFBundleName</key>
    <string>Kraki</string>
    <key>CFBundleDisplayName</key>
    <string>Kraki</string>
    <key>CFBundleExecutable</key>
    <string>kraki</string>
    <key>CFBundleIconFile</key>
    <string>app</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSBackgroundOnly</key>
    <true/>
</dict>
</plist>
PLIST

# Sign inside-out with the tentacle's JIT entitlements (Node/V8 needs them
# under the hardened runtime). --timestamp is required for notarization and
# fails without network, so only request it for a real identity.
TS=()
[ "$IDENTITY" != "-" ] && TS=(--timestamp)
ENT="$ROOT/packages/tentacle/entitlements.plist"
codesign --force --options runtime ${TS[@]+"${TS[@]}"} --entitlements "$ENT" --sign "$IDENTITY" "$APP/Contents/MacOS/kraki"
codesign --force --options runtime ${TS[@]+"${TS[@]}"} --entitlements "$ENT" --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"
lipo -archs "$APP/Contents/MacOS/kraki"
echo "Built $APP (tentacle $VERSION)"
