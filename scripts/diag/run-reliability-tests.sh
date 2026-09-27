#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/kraki-reliability.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
swiftc -O -emit-library -emit-module -module-name Pulse \
  "$ROOT"/packages/arm/ios/Vendor/Pulse/Sources/Pulse/*.swift \
  -emit-module-path "$BUILD/Pulse.swiftmodule" -o "$BUILD/libPulse.dylib"
swiftc -D DEBUG -swift-version 5 -I "$BUILD" -L "$BUILD" -lPulse \
  "$ROOT/packages/arm/ios/Kraki/Shared/EventMonitorForwarding.swift" \
  "$ROOT/packages/arm/ios/Kraki/Shared/KrakiPlatform.swift" \
  "$ROOT/packages/arm/ios/Kraki/Core/Networking/PulseManager.swift" \
  "$ROOT/packages/arm/ios/Kraki/Core/Networking/WebSocketClient.swift" \
  "$ROOT/scripts/diag/ReliabilityTests.swift" -o "$BUILD/test"
DYLD_LIBRARY_PATH="$BUILD" "$BUILD/test"
