#!/usr/bin/env bash
# Build "Kraki Tentacle.app" — the tentacle SEA binary wrapped as the helper
# bundle that Kraki for Mac embeds at Contents/Library/Helpers/.
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
# records for its own id. TCC does not key on this id at all — grants for the
# daemon are attributed to the enclosing Kraki for Mac app.
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

APP="$OUT/Kraki Tentacle.app"
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

ICONSET="$(mktemp -d)/app.iconset"
mkdir -p "$ICONSET"
for spec in "16 16" "32 16@2x" "32 32" "64 32@2x" "128 128" "256 128@2x" \
            "256 256" "512 256@2x" "512 512" "1024 512@2x"; do
  set -- $spec
  sips -z "$1" "$1" "$ROOT/logo.png" --out "$ICONSET/icon_$2.png" >/dev/null
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
    <string>Kraki Tentacle</string>
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
