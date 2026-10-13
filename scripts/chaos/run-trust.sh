#!/bin/bash
# Device trust end to end: production Swift networking (Mac test host) against
# an isolated local stack whose Tentacle enforces device trust.
#   bash scripts/chaos/run-trust.sh [-only-testing:KrakiMacTests/DeviceTrustE2ETests/test_T1_qrPairing ...]
# Local only: temporary Head DB/keys/sessions/trust store, open-auth throwaway identities.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE=/tmp/kraki-chaos
rm -rf "$STATE"; mkdir -p "$STATE/results"
cd "$ROOT/packages/tests"
env -u NODE_ENV -u KRAKI_HOME -u KRAKI_META_FILE CHAOS_DEVICE_TRUST=enforce npx tsx src/chaos/stack.ts --control-port 0 \
  > "$STATE/stack.out" 2> "$STATE/stack.log" &
STACK=$!
trap 'kill $STACK 2>/dev/null; wait $STACK 2>/dev/null; rm -f "$STATE/stack.json" "$ROOT/packages/arm/ios/KrakiTests/trust-stack.json"' EXIT
for _ in $(seq 1 150); do grep -q '^{"controlPort' "$STATE/stack.out" && break; sleep 0.2; done
grep -m1 '^{"controlPort' "$STATE/stack.out" > "$STATE/stack.json" || { echo "stack failed"; tail "$STATE/stack.log"; exit 1; }
cat "$STATE/stack.json"
platform=${KRAKI_TRUST_PLATFORM:-mac}
selectors=("$@")
if [ "$platform" = ios ]; then
  : "${KRAKI_TEST_SIMULATOR:?Use your own simulator}"
  cp "$STATE/stack.json" "$ROOT/packages/arm/ios/KrakiTests/trust-stack.json"
  [ ${#selectors[@]} -eq 0 ] && selectors=(-only-testing:KrakiTests/DeviceTrustUsabilityTests)
else
  [ ${#selectors[@]} -eq 0 ] && selectors=(-only-testing:KrakiMacTests/DeviceTrustE2ETests)
fi
cd "$ROOT"
env -u NODE_ENV -u KRAKI_HOME -u KRAKI_META_FILE bash scripts/test-native.sh "$platform" "${selectors[@]}" > "$STATE/xcode.log" 2>&1
code=$?
port=$(python3 -c 'import json;print(json.load(open("/tmp/kraki-chaos/stack.json"))["controlPort"])')
curl -s "http://127.0.0.1:$port/trust/state" > "$STATE/trust-state.json" || true
curl -s "http://127.0.0.1:$port/timeline" > "$STATE/timeline.json" || true
result=$(grep -o '/tmp/kraki-native-test\.[A-Za-z0-9]*/[a-z]*\.xcresult' "$STATE/xcode.log" | tail -1)
[ -n "$result" ] && xcrun xcresulttool get test-results tests --path "$result" 2>/dev/null | python3 -c '
import json,sys
def walk(n):
    if n.get("nodeType")=="Test Case":
        print(("PASS " if n.get("result")=="Passed" else n.get("result","?").upper()+" ")+n["name"])
        for c in n.get("children",[]):
            if c.get("nodeType")=="Failure Message": print("   ",c.get("name","")[:260])
    for c in n.get("children",[]): walk(c)
[walk(n) for n in json.load(sys.stdin).get("testNodes",[])]'
grep -E "Testing failed|error: .*\.swift" "$STATE/xcode.log" | grep -v "error: -\[" | head -5
echo "trust state: $(cat "$STATE/trust-state.json")"
exit $code
