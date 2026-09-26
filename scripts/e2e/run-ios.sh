#!/bin/bash
# usage: run-ios.sh <script-scenario> <UITest name>
cd /Users/corelli/Documents/Repos/kraki-mac-chat-ux
rm -f /tmp/kraki-e2e-session
pnpm exec tsx scripts/e2e/question-e2e.ts $1 > /tmp/e2e-$2.script.log 2>&1 &
SCRIPT=$!
for i in $(seq 1 180); do [ -s /tmp/kraki-e2e-session ] && break; sleep 1; done
SID=$(cat /tmp/kraki-e2e-session)
cd packages/arm/ios
TEST_RUNNER_KRAKI_E2E_SESSION=$SID TEST_RUNNER_KRAKI_E2E_PORT=4470 xcodebuild test-without-building -project Kraki.xcodeproj -scheme KrakiUITests -destination "id=B53EA230-935A-4463-A794-279756E55A59" -derivedDataPath /tmp/kraki-mac-chat-ux-ui-dd -only-testing:KrakiUITests/QuestionE2EUITests/$2 > /tmp/e2e-$2.ui.log 2>&1
echo "ui=$? session=$SID"
grep -E "error:|Test Case.*(passed|failed)" /tmp/e2e-$2.ui.log | sed 's/.*error: -\[[^]]*\] : //' | cut -c1-180 | head -6
wait $SCRIPT; echo "script=$?"
grep -E "\[e2e\] (UI ANSWER|FINAL|SPINE|FAIL)" /tmp/e2e-$2.script.log | cut -c1-300
