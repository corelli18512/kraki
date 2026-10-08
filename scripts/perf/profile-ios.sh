#!/bin/bash
# Manual: Time Profiler traces of MainThreadProfileScenarioTests phases on an
# iPhone Simulator. Usage: KRAKI_TEST_SIMULATOR=<udid> scripts/perf/profile-ios.sh Phase [OutDir]
set -uo pipefail
phase="$1"; out="${2:-/tmp/kraki-profile}"; mkdir -p "$out"
root="$(cd "$(dirname "$0")/../.." && pwd)"
rm -f /tmp/kraki-profile-ready /tmp/kraki-profile-go
KRAKI_TEST_SIMULATOR="$KRAKI_TEST_SIMULATOR" bash "$root/scripts/test-native.sh" ios --perf \
  "-only-testing:KrakiTests/MainThreadProfileScenarioTests/test$phase" > "$out/$phase-xcode.log" 2>&1 &
test=$!
for _ in $(seq 1 900); do [ -s /tmp/kraki-profile-ready ] && break; sleep 1; done
pid=$(cat /tmp/kraki-profile-ready 2>/dev/null) || { echo "scenario never became ready"; wait $test; exit 1; }
rm -rf "$out/$phase.trace"
# The window must end before the scenario does (a vanished target leaves an empty trace).
# Simulator apps run as host processes; `--device <sim> --attach` never
# finishes and a host `--attach <pid>` cannot see them, so record the whole
# host and filter on the pid when exporting (scripts/perf/main-thread.py).
xcrun xctrace record --template 'Time Profiler' --all-processes \
  --time-limit "${PROFILE_SECONDS:-30}s" --output "$out/$phase.trace" > "$out/$phase-xctrace.log" 2>&1 &
rec=$!
sleep 4; touch /tmp/kraki-profile-go
wait $rec
wait $test; code=$?
echo "$pid" > "$out/$phase.pid"
echo "test exit=$code pid=$pid trace=$out/$phase.trace"
