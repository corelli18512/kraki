#!/bin/bash
# Web network-resilience scenarios: the built web app in Chromium against the
# isolated chaos stack. Local only.
#   bash scripts/chaos/run-web.sh [playwright args, e.g. -g "W3"]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE=/tmp/kraki-chaos
rm -rf "$STATE"; mkdir -p "$STATE/results"
cd "$ROOT/packages/tests"
env -u NODE_ENV -u KRAKI_HOME -u KRAKI_META_FILE npx tsx src/chaos/stack.ts --control-port 0 \
  > "$STATE/stack.out" 2> "$STATE/stack.log" &
STACK=$!
trap 'kill $STACK 2>/dev/null; wait $STACK 2>/dev/null' EXIT
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
