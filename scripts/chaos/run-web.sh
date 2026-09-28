#!/bin/bash
# Web network-resilience scenarios: the built web app in Chromium against the
# isolated chaos stack. Local only.
#   bash scripts/chaos/run-web.sh [playwright args, e.g. -g "W3"]
#   KRAKI_NETEM=1 (Linux CI, sudo): also packet-level scenarios N1–N4
#   KRAKI_SOAK_MINUTES=30 CHAOS_SEED=7: randomized soak S1
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE=/tmp/kraki-chaos
rm -rf "$STATE"; mkdir -p "$STATE/results"
NETEM_SH="$ROOT/scripts/chaos/netem.sh"
if [ "${KRAKI_NETEM:-}" = 1 ]; then
  # Packet-level faults (Linux CI only): before the stack, so lo's MTU is set
  # before any connection exists.
  sudo bash "$NETEM_SH" setup
fi
cd "$ROOT/packages/tests"
env -u NODE_ENV -u KRAKI_HOME -u KRAKI_META_FILE npx tsx src/chaos/stack.ts --control-port 0 \
  > "$STATE/stack.out" 2> "$STATE/stack.log" &
STACK=$!
cleanup() {
  kill $STACK 2>/dev/null; wait $STACK 2>/dev/null
  if [ "${KRAKI_NETEM:-}" = 1 ]; then sudo bash "$NETEM_SH" teardown; fi
}
trap cleanup EXIT
for _ in $(seq 1 150); do grep -q '^{"controlPort' "$STATE/stack.out" && break; sleep 0.2; done
grep -m1 '^{"controlPort' "$STATE/stack.out" > "$STATE/stack.json" || { echo "stack failed"; tail "$STATE/stack.log"; exit 1; }
cd "$ROOT/packages/arm/web"
env -u NODE_ENV npx playwright test -c playwright.resilience.config.ts "$@" > "$STATE/web.log" 2>&1
code=$?
grep -E "✓|✘|passed|failed|Error:|expect\(" "$STATE/web.log" | head -40
python3 - "$STATE/results" <<'PY'
import json,sys,pathlib
for p in sorted(pathlib.Path(sys.argv[1]).glob('web_*.json')):
    print(p.stem + ': ' + json.dumps(json.loads(p.read_text())))
PY
exit $code
