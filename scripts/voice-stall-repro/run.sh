#!/usr/bin/env bash
# usage: STALL_MODE=hold|stop-read STALL_MS=10000 scripts/voice-stall-repro/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export WS_PATH="${WS_PATH:-$(ls -d "$HOME"/Documents/Repos/kraki/node_modules/.pnpm/ws@8*/node_modules/ws | head -1)}"
node "$here/gateway-and-proxy.mjs" & gw=$!
trap 'kill $gw 2>/dev/null' EXIT
sleep 0.5
cd "$here/../../packages/arm/ios/Vendor/VoiceInputCore"
VOICE_STALL_REPRO_URL=ws://127.0.0.1:${PROXY_PORT:-19401} swift test --skip-build \
  --filter NetworkStallReproTests 2>&1 | grep -E '^\[client|passed|failed|skipped' || true
sleep 0.3
