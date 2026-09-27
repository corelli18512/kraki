#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/kraki-diag-native.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
swiftc -O -D KRAKI_DIAG -D KRAKI_DIAG_TESTING \
  "$ROOT/packages/arm/ios/Kraki/Core/Diagnostics/DiagRecorder.swift" \
  "$ROOT/packages/arm/ios/Kraki/Core/Diagnostics/KrakiDiag.swift" \
  "$ROOT/packages/arm/ios/Kraki/Core/Diagnostics/DiagRunLoop.swift" \
  "$ROOT/packages/arm/ios/Kraki/Core/Crypto/CryptoManager.swift" \
  "$ROOT/scripts/diag/NativeTests.swift" -o "$OUT/tests"
"$OUT/tests"
