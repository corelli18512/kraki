#!/bin/bash
# Network-resilience scenarios: production Swift networking (Mac test host)
# (see docs/network-resilience-test-plan.md)
# against an isolated local stack behind a fault-injection proxy.
#   bash scripts/chaos/run-native.sh [-only-testing:KrakiMacTests/NetworkResilienceTests/test_A1_flashReset ...]
# Local only: temporary Head DB/keys/sessions, open-auth throwaway identity.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE=/tmp/kraki-chaos
rm -rf "$STATE"; mkdir -p "$STATE/results"
# Random chaos: CHAOS_SEED / CHAOS_ITERATIONS (default seed 20260928, 3 rounds).
if [ -n "${CHAOS_SEED:-}${CHAOS_ITERATIONS:-}" ]; then
  printf '{"seed": %s, "iterations": %s}\n' "${CHAOS_SEED:-20260928}" "${CHAOS_ITERATIONS:-3}" > "$STATE/chaos.json"
fi
cd "$ROOT/packages/tests"
env -u NODE_ENV -u KRAKI_HOME -u KRAKI_META_FILE npx tsx src/chaos/stack.ts --control-port 0 \
  > "$STATE/stack.out" 2> "$STATE/stack.log" &
STACK=$!
trap 'kill $STACK 2>/dev/null; wait $STACK 2>/dev/null; rm -f "$STATE/stack.json"' EXIT
for _ in $(seq 1 150); do grep -q '^{"controlPort' "$STATE/stack.out" && break; sleep 0.2; done
grep -m1 '^{"controlPort' "$STATE/stack.out" > "$STATE/stack.json" || { echo "stack failed"; tail "$STATE/stack.log"; exit 1; }
cat "$STATE/stack.json"
selectors=("$@")
[ ${#selectors[@]} -eq 0 ] && selectors=(-only-testing:KrakiMacTests/NetworkResilienceTests)
cd "$ROOT"
env -u NODE_ENV -u KRAKI_HOME -u KRAKI_META_FILE bash scripts/test-native.sh mac "${selectors[@]}" > "$STATE/xcode.log" 2>&1
code=$?
port=$(python3 -c 'import json;print(json.load(open("/tmp/kraki-chaos/stack.json"))["controlPort"])')
curl -s "http://127.0.0.1:$port/timeline" > "$STATE/timeline.json" || true
curl -s "http://127.0.0.1:$port/stats" > "$STATE/stats.json" || true
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
python3 - "$STATE/results" <<'PY'
import json,sys,pathlib
for p in sorted(pathlib.Path(sys.argv[1]).glob('*.json')):
    m=json.loads(p.read_text()); s=m.pop('scenario',p.stem)
    print(f"{s}: " + ", ".join(f"{k}={v}" for k,v in m.items() if k!='stats'))
PY
exit $code
