#!/usr/bin/env bash
# Deploy a new version of @kraki/head to this relay host.
#
# Idempotent and safe to re-run. Snapshots the live state before touching
# anything, and auto-rolls-back if the restarted relay doesn't come up
# healthy.
#
# Usage (run as root on the relay host):
#   deploy-edge-relay.sh <version>      # e.g. deploy-edge-relay.sh 0.12.0
#
# Assumptions about the host layout (see SELF-HOSTING.md):
#   - systemd unit:         /etc/systemd/system/kraki-relay.service
#   - canonical env file:   /etc/kraki/relay.env  (referenced by unit's EnvironmentFile=)
#   - SQLite DB:            /var/lib/kraki/kraki-relay.db
#   - npm global install of @kraki/head provides /usr/local/bin/kraki-relay
#   - relay listens on 127.0.0.1:4000 (nginx in front handles TLS)

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>" >&2
  echo "  example: $0 0.12.0" >&2
  exit 2
fi

UNIT=/etc/systemd/system/kraki-relay.service
ENV_FILE=/etc/kraki/relay.env
DB=/var/lib/kraki/kraki-relay.db
BACKUP_ROOT=/root/kraki-backups
RELAY_BIN=/usr/local/bin/kraki-relay
HEALTH_URL=http://127.0.0.1:4000/

if [ "$(id -u)" -ne 0 ]; then
  echo "must be run as root" >&2
  exit 2
fi

for tool in sqlite3 npm systemctl curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: $tool" >&2
    exit 2
  fi
done

current_version() {
  if [ -x "$RELAY_BIN" ]; then
    # dotenv may print advisory text before the version; extract the semver.
    "$RELAY_BIN" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | tail -1 || true
  fi
}

CURRENT_VERSION="$(current_version || true)"
echo "current installed version: ${CURRENT_VERSION:-unknown}"
echo "target version:           $VERSION"

TS="$(date +%Y%m%d-%H%M%S)"
SNAP="$BACKUP_ROOT/pre-$VERSION-$TS"
mkdir -p "$SNAP"
chmod 700 "$SNAP"

echo "==> snapshotting to $SNAP"

# WAL-safe DB backup. .backup leaves the live DB untouched.
sqlite3 "$DB" ".backup '$SNAP/kraki-relay.db'"

# Sanity-check the backup is openable.
sqlite3 "$SNAP/kraki-relay.db" "PRAGMA integrity_check;" >"$SNAP/integrity_check.txt"
if ! grep -q '^ok$' "$SNAP/integrity_check.txt"; then
  echo "DB backup integrity check failed — aborting" >&2
  cat "$SNAP/integrity_check.txt" >&2
  exit 1
fi

# Copy env and unit file. Capture install metadata.
cp -p "$ENV_FILE" "$SNAP/relay.env" 2>/dev/null || echo "WARN: $ENV_FILE missing"
cp -p "$UNIT" "$SNAP/kraki-relay.service"
{ echo "previous_version=${CURRENT_VERSION:-unknown}"; \
  echo "target_version=$VERSION"; \
  echo "timestamp=$TS"; \
  echo "host=$(hostname)"; } >"$SNAP/manifest"

echo "snapshot ready: $SNAP"

# Best-effort retention sweep for full pre-deploy snapshots (keep 30 days).
find "$BACKUP_ROOT" -maxdepth 1 -type d -name 'pre-*' -mtime +30 -exec rm -rf {} \; 2>/dev/null || true

# ---- install ----

# Pin to the upstream registry. Edge nodes in China often have npm configured
# for registry.npmmirror.com, which lags behind on new versions by hours.
# We want the freshly-published @kraki/head@$VERSION right now, not whenever
# the mirror syncs.
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
echo "==> npm install -g --registry=$NPM_REGISTRY @kraki/head@$VERSION"
npm install -g --registry="$NPM_REGISTRY" "@kraki/head@$VERSION"

INSTALLED_VERSION="$(current_version || true)"
if [ "$INSTALLED_VERSION" != "$VERSION" ]; then
  echo "ERROR: kraki-relay --version reports '$INSTALLED_VERSION', expected '$VERSION'" >&2
  echo "       (snapshot kept at $SNAP)" >&2
  exit 1
fi
echo "installed binary reports version $INSTALLED_VERSION"

# ---- restart ----

rollback() {
  local reason="$1"
  echo "==> ROLLBACK ($reason)"
  if [ -n "${CURRENT_VERSION:-}" ] && [ "$CURRENT_VERSION" != "$VERSION" ]; then
    npm install -g --registry="$NPM_REGISTRY" "@kraki/head@$CURRENT_VERSION" || true
  fi
  cp -p "$SNAP/kraki-relay.service" "$UNIT"
  if [ -f "$SNAP/relay.env" ]; then
    cp -p "$SNAP/relay.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  systemctl daemon-reload
  systemctl restart kraki-relay || true
  sleep 2
  systemctl status kraki-relay --no-pager -n 10 || true
  echo "rolled back. snapshot: $SNAP" >&2
  exit 1
}

echo "==> systemctl restart kraki-relay"
if ! systemctl restart kraki-relay; then
  rollback "systemctl restart failed"
fi

sleep 3

if ! systemctl is-active --quiet kraki-relay; then
  systemctl status kraki-relay --no-pager -n 20 || true
  rollback "service not active after restart"
fi

# Health check via local HTTP. New head reports {"name":"@kraki/head","version":"X","status":"ok"}.
HEALTH_BODY=""
for attempt in 1 2 3 4 5; do
  if HEALTH_BODY="$(curl -sf --max-time 3 "$HEALTH_URL" 2>/dev/null)"; then
    break
  fi
  sleep 1
done

if [ -z "$HEALTH_BODY" ]; then
  rollback "health endpoint $HEALTH_URL not responding"
fi

if ! echo "$HEALTH_BODY" | grep -q "\"version\":\"$VERSION\""; then
  echo "health endpoint reports unexpected body:" >&2
  echo "  $HEALTH_BODY" >&2
  rollback "health body does not advertise version $VERSION"
fi

echo
echo "deploy OK: kraki-relay $VERSION running, /127.0.0.1:4000/ healthy"
echo "snapshot: $SNAP"
echo
echo "manual rollback (within 30 days of snapshot):"
echo "  npm install -g @kraki/head@${CURRENT_VERSION:-<prev>}"
echo "  cp $SNAP/kraki-relay.service $UNIT"
echo "  cp $SNAP/relay.env $ENV_FILE && chmod 600 $ENV_FILE"
echo "  systemctl daemon-reload && systemctl restart kraki-relay"
