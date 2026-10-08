#!/bin/bash
# Manual: Time Profiler trace of one MacMainThreadProfileScenarioTests phase.
# Usage: scripts/perf/profile-mac.sh Phase [OutDir]   (opens a floating window)
set -uo pipefail
phase="$1"; out="${2:-/tmp/kraki-profile-mac}"; mkdir -p "$out"
root="$(cd "$(dirname "$0")/../.." && pwd)"
rm -f /tmp/kraki-profile-ready /tmp/kraki-profile-go
KRAKI_RUN_UI_TESTS=1 bash "$root/scripts/test-native.sh" mac --perf \
  "-only-testing:KrakiMacTests/MacMainThreadProfileScenarioTests/test$phase" > "$out/$phase-xcode.log" 2>&1 &
test=$!
for _ in $(seq 1 900); do [ -s /tmp/kraki-profile-ready ] && break; sleep 1; done
pid=$(cat /tmp/kraki-profile-ready 2>/dev/null) || { echo "scenario never became ready"; wait $test; exit 1; }
rm -rf "$out/$phase.trace"
# The window must end before the scenario does.
xcrun xctrace record --template 'Time Profiler' --attach "$pid" \
  --time-limit "${PROFILE_SECONDS:-15}s" --output "$out/$phase.trace" > "$out/$phase-xctrace.log" 2>&1 &
rec=$!
sleep 4; touch /tmp/kraki-profile-go
wait $rec
wait $test; code=$?
echo "$pid" > "$out/$phase.pid"
echo "test exit=$code pid=$pid trace=$out/$phase.trace"
