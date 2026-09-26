#!/bin/bash
# usage: run-mac.sh <script-scenario>  — starts the driver script, launches an
# isolated Kraki Dev on the local stack with the created session open.
cd /Users/corelli/Documents/Repos/kraki-mac-chat-ux
rm -f /tmp/kraki-e2e-session /tmp/kraki-mac-e2e.sock
pnpm exec tsx scripts/e2e/question-e2e.ts $1 > /tmp/e2e-mac-$1.script.log 2>&1 &
echo $! > /tmp/kraki-e2e-script.pid
for i in $(seq 1 180); do [ -s /tmp/kraki-e2e-session ] && break; sleep 1; done
SID=$(cat /tmp/kraki-e2e-session)
pkill -f "kraki-mac-chat-ux-e2e-dd/Build/Products/Debug/Kraki Dev.app" ; sleep 1
rm -rf /tmp/kraki-mac-e2e-data; mkdir -p /tmp/kraki-mac-e2e-data
env KRAKI_DEV_LOCAL=1 KRAKI_LOCAL_RELAY_PORT=4470 KRAKI_DATA_DIR=/tmp/kraki-mac-e2e-data \
  KRAKI_NATIVE_AUTOMATION=1 KRAKI_NATIVE_AUTOMATION_VISIBLE=1 KRAKI_NATIVE_AUTOMATION_SOCKET=/tmp/kraki-mac-e2e.sock \
  KRAKI_OPEN_SESSION_ID=$SID \
  "/tmp/kraki-mac-chat-ux-e2e-dd/Build/Products/Debug/Kraki Dev.app/Contents/MacOS/Kraki Dev" > /tmp/kraki-mac-e2e-app.log 2>&1 &
echo "session=$SID"
