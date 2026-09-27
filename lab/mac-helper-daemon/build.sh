#!/bin/bash
# build.sh <version> <signing-identity|-> <outdir>
# Produces "<outdir>/v<version>/Kraki Lab.app" with the helper embedded at
# Contents/Library/Helpers/Kraki Lab Agent.app, signed inside-out.
set -euo pipefail
V="$1"; ID="$2"; OUT="$3/v$V"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"
rm -rf "$OUT"; mkdir -p "$OUT"
APP="$OUT/Kraki Lab.app"
HELPER="$APP/Contents/Library/Helpers/Kraki Lab Agent.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Library/LaunchAgents" \
         "$HELPER/Contents/MacOS" "$HELPER/Contents/Resources"

# Icon from the brand logo (both bundles).
ICONSET="$TMP/app.iconset"; mkdir -p "$ICONSET"
for spec in "16 16" "32 16@2x" "32 32" "64 32@2x" "128 128" "256 128@2x" "256 256" "512 256@2x" "512 512" "1024 512@2x"; do
  set -- $spec; sips -z "$1" "$1" "$REPO/logo.png" --out "$ICONSET/icon_$2.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/app.icns"
cp "$APP/Contents/Resources/app.icns" "$HELPER/Contents/Resources/app.icns"

echo "let LAB_VERSION = \"$V\"" > "$TMP/version.swift"
swiftc -O -target arm64-apple-macos15 -o "$HELPER/Contents/MacOS/kraki-lab-agent" "$HERE/agent/main.swift" "$TMP/version.swift"
swiftc -O -target arm64-apple-macos15 -o "$APP/Contents/MacOS/kraki-lab" "$HERE/app/main.swift" -framework ServiceManagement
clang -O2 -arch arm64 -mmacosx-version-min=15.0 -o "$OUT/child" "$HERE/child/child.c"
codesign --force -s - "$OUT/child"

plist() { # path id name exe extra
  cat > "$1" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$2</string>
<key>CFBundleName</key><string>$3</string>
<key>CFBundleDisplayName</key><string>$3</string>
<key>CFBundleExecutable</key><string>$4</string>
<key>CFBundleIconFile</key><string>app</string>
<key>CFBundleVersion</key><string>$V</string>
<key>CFBundleShortVersionString</key><string>$V</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
$5
</dict></plist>
P
}
plist "$APP/Contents/Info.plist" chat.kraki.lab.app "Kraki Lab" kraki-lab "<key>NSPrincipalClass</key><string>NSApplication</string>"
plist "$HELPER/Contents/Info.plist" chat.kraki.lab.agent "Kraki Lab Agent" kraki-lab-agent "<key>LSUIElement</key><true/><key>LSBackgroundOnly</key><true/>"

agent() { # name args-xml extra-xml
  cat > "$APP/Contents/Library/LaunchAgents/chat.kraki.lab.sm-$1.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>chat.kraki.lab.sm-$1</string>
$3
<key>ProgramArguments</key><array>$2</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>AssociatedBundleIdentifiers</key><array><string>chat.kraki.lab.app</string></array>
</dict></plist>
P
}
BP="<key>BundleProgram</key><string>Contents/Library/Helpers/Kraki Lab Agent.app/Contents/MacOS/kraki-lab-agent</string>"
agent direct   "<string>kraki-lab-agent</string><string>daemon</string><string>--tag</string><string>sm-direct</string>" "$BP"
agent launcher "<string>kraki-lab-agent</string><string>launch</string><string>--tag</string><string>sm-launcher</string>" "$BP"
agent openb    "<string>/usr/bin/open</string><string>-W</string><string>-n</string><string>-b</string><string>chat.kraki.lab.agent</string><string>--args</string><string>daemon</string><string>--tag</string><string>sm-openb</string>" ""

ENT="$REPO/packages/tentacle/entitlements.plist"
# Inside-out, same flags as the real CLI bundle.
SIGN=(codesign --force --options runtime -s "$ID")
[ "$ID" != "-" ] && SIGN+=(--timestamp)
"${SIGN[@]}" --entitlements "$ENT" "$HELPER/Contents/MacOS/kraki-lab-agent"
"${SIGN[@]}" --entitlements "$ENT" "$HELPER"
"${SIGN[@]}" "$APP/Contents/MacOS/kraki-lab"
"${SIGN[@]}" "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"
rm -rf "$TMP"
echo "built $APP"
