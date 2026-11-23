#!/usr/bin/env bash
# Deploy a new @kraki/head on a relay host, or roll back to an earlier one.
#
# Host layout (Kraki's relays):
#   /opt/kraki-head/releases/<version>/   one `npm --prefix` install per release
#   /etc/systemd/system/kraki-relay.service.d/zzz-head-release.conf
#       systemd drop-in that selects the release:
#       ExecStart="<node>" "/opt/kraki-head/releases/<version>/node_modules/@kraki/head/dist/cli.js" ... "--db" "<db>"
#   /opt/kraki-head/backups/   database snapshots, and the drop-in of each replaced release
#   /usr/local/bin/kraki-watch optional; told about the planned restart
#
# Usage, as root on the relay host:
#   deploy-edge-relay.sh <version>           back up the database and the drop-in, install
#                                            <version>, point the drop-in at it, restart and verify;
#                                            on any failure after the switch, or on HUP/INT/TERM/PIPE
#                                            (e.g. the ssh session drops), restore the previous drop-in
#   deploy-edge-relay.sh rollback <version>  switch back to the saved drop-in of <version>
# Only one deploy or rollback runs at a time (flock on /opt/kraki-head/backups/.deploy.lock).
#
# Pass the environment after sudo: its env_reset drops variables set before it.
#   sudo KRAKI_PUBLIC_URL=https://cn.relay.kraki.chat bash scripts/deploy-edge-relay.sh 0.22.0
#   ssh <host> 'sudo KRAKI_PUBLIC_URL=https://cn.relay.kraki.chat bash -s 0.22.0' < scripts/deploy-edge-relay.sh
#
# Verification: the service is active, http://127.0.0.1:<port>/ reports the version, and a
# WebSocket upgrade is answered with 101. With KRAKI_PUBLIC_URL set, the same version and
# upgrade through the proxy. (Head's / reports its version; it is not a readiness check.)
#
# Environment:
#   NPM_REGISTRY       registry for the install (default https://registry.npmjs.org; China
#                      mirrors lag new versions by hours)
#   KRAKI_PUBLIC_URL   see above
#   KRAKI_DEPLOY_ROOT  prefix for every host path, so scripts/deploy-edge-relay.test.mjs can run
#                      this against a fake root with fake systemctl/curl/npm (and without flock
#                      if the test machine has none). Never set on a relay.

set -euo pipefail

ROOT="${KRAKI_DEPLOY_ROOT:-}"
DROPIN="$ROOT/etc/systemd/system/kraki-relay.service.d/zzz-head-release.conf"
REL="$ROOT/opt/kraki-head/releases"
BK="$ROOT/opt/kraki-head/backups"
# Full path: sudo's PATH on some relays lacks /usr/local/bin.
KRAKI_WATCH="$ROOT/usr/local/bin/kraki-watch"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
UNIT=kraki-relay
HEAD_CLI=node_modules/@kraki/head/dist/cli.js

die() { echo "error: $*" >&2; exit 2; }
valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }
usage() {
  echo "usage: deploy-edge-relay.sh <version> | deploy-edge-relay.sh rollback <version>" >&2
  exit 2
}

# Holds $BK/.deploy.lock on fd 9 until the script exits.
lock_deploys() {
  [ -d "$BK" ] || install -d -m 700 "$BK"
  exec 9>"$BK/.deploy.lock"
  if command -v flock >/dev/null 2>&1; then
    flock -n 9 || die "another deploy or rollback is running on this host ($BK/.deploy.lock)"
  elif [ -n "$ROOT" ]; then
    echo "note: no flock on this machine; running unlocked against the test root" >&2
  else
    die "missing required tool: flock"
  fi
}

# Sets CURRENT (release the drop-in runs), NODE, NODE_BIN_DIR, DB and LOCAL_URL.
read_dropin() {
  [ -f "$DROPIN" ] || { echo "no $DROPIN: this host does not use the per-release layout" >&2; return 1; }
  local exec_line cli port
  exec_line=$(grep '^ExecStart="' "$DROPIN" | tail -1) || { echo "no ExecStart=\"...\" in $DROPIN" >&2; return 1; }
  NODE=$(sed -E 's/^ExecStart="([^"]+)".*/\1/' <<<"$exec_line")
  cli=$(sed -nE 's/^ExecStart="[^"]+" "([^"]+)".*/\1/p' <<<"$exec_line")
  case "$cli" in
    "$REL"/*/"$HEAD_CLI") ;;
    *) echo "$DROPIN does not run Head from $REL/<version>: $exec_line" >&2; return 1 ;;
  esac
  CURRENT=${cli#"$REL"/}
  CURRENT=${CURRENT%%/*}
  valid_version "$CURRENT" || { echo "unexpected release directory in $DROPIN: $cli" >&2; return 1; }
  DB=$(sed -nE 's/.*"--db" "([^"]+)".*/\1/p' <<<"$exec_line")
  port=$(sed -nE 's/.*"--port" "([0-9]+)".*/\1/p' <<<"$exec_line")
  LOCAL_URL="http://127.0.0.1:${port:-4000}"
  NODE_BIN_DIR=$(dirname "$NODE")
}

# Planned restart: keep kraki-watch from paging about it.
maintenance() {
  if [ -x "$KRAKI_WATCH" ]; then
    # 9>&-: a long-lived kraki-watch must not inherit (and hold) the deploy lock.
    "$KRAKI_WATCH" maintenance 10 9>&- || echo "warning: kraki-watch maintenance failed" >&2
  fi
}

reports_version() {  # url version
  local body=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    body=$(curl -sf --max-time 3 "$1" 2>/dev/null) && break
    sleep 1
  done
  echo "$1: ${body:-no answer}"
  grep -qF "\"version\":\"$2\"" <<<"$body"
}

websocket_upgrades() {  # url
  local key status
  key=$(head -c 16 /dev/urandom | base64)
  # The upgraded connection stays open until --max-time; only the status line matters.
  status=$(curl -sS -i -N --http1.1 --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $key" "$1" 2>/dev/null | tr -d '\r' | grep -m1 '^HTTP/' || true)
  echo "$1 WebSocket upgrade: ${status:-no answer}"
  [[ "$status" == "HTTP/1.1 101"* ]]
}

verify() {  # version
  systemctl is-active --quiet "$UNIT" || { echo "$UNIT is not active"; return 1; }
  reports_version "$LOCAL_URL/" "$1" || return 1
  websocket_upgrades "$LOCAL_URL/" || return 1
  if [ -n "${KRAKI_PUBLIC_URL:-}" ]; then
    reports_version "${KRAKI_PUBLIC_URL%/}/" "$1" || return 1
    websocket_upgrades "${KRAKI_PUBLIC_URL%/}/" || return 1
  fi
}

restart_unit() {
  maintenance
  systemctl daemon-reload || return 1
  systemctl restart "$UNIT" || return 1
  sleep 3
}

# Signal handler while the switched drop-in is unverified: put back the saved
# previous drop-in ($RESTORE_DROPIN) and restart. Output may go nowhere (the
# ssh session that sent the signal is gone), so nothing here may stop it.
restore_on_signal() {  # signal exit-status
  trap '' HUP INT TERM PIPE
  set +e
  cp -p "$RESTORE_DROPIN" "$DROPIN"
  maintenance >/dev/null 2>&1
  systemctl daemon-reload
  systemctl restart "$UNIT"
  echo "SIG$1 after the drop-in switch: restored $RESTORE_DROPIN and restarted $UNIT; check it" >&2
  exit "$2"
}

install_release() {  # version
  local dir="$REL/$1" installed
  if [ ! -f "$dir/node_modules/@kraki/head/package.json" ]; then
    rm -rf "$dir.tmp"
    mkdir -p "$dir.tmp"
    PATH="$NODE_BIN_DIR:$PATH" "$NODE_BIN_DIR/npm" --prefix "$dir.tmp" install --save-exact --no-audit --no-fund \
      --omit=dev --registry "$NPM_REGISTRY" "@kraki/head@$1"
    rm -rf "$dir"
    mv "$dir.tmp" "$dir"
  fi
  installed=$("$NODE" -p "require('$dir/node_modules/@kraki/head/package.json').version")
  [ "$installed" = "$1" ] || die "$dir has @kraki/head $installed, not $1"
  # The native module must load under the node the unit runs.
  (cd "$dir" && "$NODE" -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()") \
    || die "better-sqlite3 in $dir does not load under $NODE"
  "$NODE" -e "console.log('installed $1:', ['protocol', 'crypto', 'pulse'].map((p) => { try { return p + ' ' + require('$dir/node_modules/@kraki/' + p + '/package.json').version } catch { return p + ' ?' } }).join(', '))"
}

deploy() {  # version
  local new=$1 prev snapshot schema_before schema_after ts
  valid_version "$new" || die "not a version: $new"
  read_dropin || exit 2
  prev=$CURRENT
  [ "$new" != "$prev" ] || die "$UNIT already runs $new"
  [ -x "$NODE_BIN_DIR/npm" ] || die "no npm next to $NODE"
  [ -f "$DB" ] || die "no database at $DB"
  lock_deploys
  echo "host=$(hostname) running=$prev target=$new node=$NODE ($("$NODE" --version)) db=$DB"

  echo "==> back up the database and the $prev drop-in"
  [ -d "$BK" ] || install -d -m 700 "$BK"
  ts=$(date -u +%Y%m%d-%H%M%S)
  snapshot="$BK/head-pre-$new-$ts.db"
  sqlite3 "$DB" ".backup '$snapshot'"
  [ "$(sqlite3 "$snapshot" 'PRAGMA integrity_check;')" = ok ] || die "integrity check of $snapshot failed"
  schema_before=$(sqlite3 "$DB" 'PRAGMA user_version;')
  cp -p "$DROPIN" "$BK/zzz-head-release.conf.$prev"
  echo "snapshot $snapshot (integrity ok, user_version $schema_before); drop-in saved as $BK/zzz-head-release.conf.$prev"

  echo "==> install @kraki/head@$new into $REL/$new"
  install_release "$new"

  echo "==> switch the drop-in from $prev to $new"
  sed "s#/releases/${prev//./\\.}/#/releases/$new/#g" "$DROPIN" > "$DROPIN.new"
  grep -qF "\"$REL/$new/$HEAD_CLI\"" "$DROPIN.new" || { rm -f "$DROPIN.new"; die "could not point the drop-in at $new"; }
  cat "$DROPIN.new"
  RESTORE_DROPIN="$BK/zzz-head-release.conf.$prev"
  trap 'restore_on_signal HUP 129' HUP
  trap 'restore_on_signal INT 130' INT
  trap 'restore_on_signal PIPE 141' PIPE
  trap 'restore_on_signal TERM 143' TERM
  # No external command between the switch and the restart: a dropped session
  # could kill it with SIGPIPE before the trap above could restore the old drop-in.
  mv "$DROPIN.new" "$DROPIN"

  if restart_unit && verify "$new"; then
    trap - HUP INT TERM PIPE
    schema_after=$(sqlite3 "$DB" 'PRAGMA user_version;')
    echo "user_version $schema_before -> $schema_after"
    echo "deploy OK: $new on $(hostname). Roll back with: deploy-edge-relay.sh rollback $prev"
    return 0
  fi

  journalctl -u "$UNIT" -n 30 --no-pager -o cat || true
  echo "==> ROLLBACK to $prev: $new did not come up healthy"
  cp -p "$BK/zzz-head-release.conf.$prev" "$DROPIN"
  if restart_unit && verify "$prev"; then
    echo "rolled back to $prev"
  else
    echo "error: $prev did not come back healthy either; check $UNIT now" >&2
  fi
  schema_after=$(sqlite3 "$DB" 'PRAGMA user_version;' || echo '?')
  if [ "$schema_after" != "$schema_before" ]; then
    # Never overwrite the live database with an older snapshot as part of a code rollback.
    echo "warning: $new moved the database schema ($schema_before -> $schema_after); $prev now runs on it." >&2
    echo "         The pre-deploy snapshot is $snapshot." >&2
  fi
  exit 1
}

rollback() {  # version
  local target=$1 saved
  valid_version "$target" || die "not a version: $target"
  saved="$BK/zzz-head-release.conf.$target"
  if [ ! -f "$saved" ]; then
    echo "error: no saved drop-in for $target. Saved:" >&2
    find "$BK" -maxdepth 1 -name 'zzz-head-release.conf.*' -exec basename {} \; 2>/dev/null | sed 's/^zzz-head-release\.conf\./  /' >&2
    exit 2
  fi
  grep -qF "\"$REL/$target/$HEAD_CLI\"" "$saved" || die "$saved does not run $REL/$target"
  [ -f "$REL/$target/$HEAD_CLI" ] || die "$REL/$target is not installed any more"
  lock_deploys
  if read_dropin; then
    [ "$CURRENT" != "$target" ] || die "$UNIT already runs $target"
    # Keep the release being left, to roll forward again.
    cp -p "$DROPIN" "$BK/zzz-head-release.conf.$CURRENT"
    echo "==> roll back from $CURRENT to $target (saved $BK/zzz-head-release.conf.$CURRENT)"
  else
    echo "==> roll back to $target (the current drop-in is not usable)"
  fi
  cp -p "$saved" "$DROPIN"
  read_dropin || exit 2
  if restart_unit && verify "$target"; then
    echo "rollback OK: $target on $(hostname)"
    return 0
  fi
  journalctl -u "$UNIT" -n 30 --no-pager -o cat || true
  echo "error: $target did not come up healthy after the rollback; check $UNIT now" >&2
  exit 1
}

# deploy/rollback run from the last command, which bash has read to the end
# of the script before it starts: with `bash -s`, no child process (npm,
# kraki-watch, ...) can read the rest of the script from stdin.
case "${1:-}" in
  ''|-h|--help) usage ;;
esac
[ -n "$ROOT" ] || [ "$(id -u)" -eq 0 ] || die "run as root on the relay host"
for tool in systemctl curl sqlite3; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
if [ "$1" = rollback ]; then
  [ $# -eq 2 ] || usage
  rollback "$2"
else
  [ $# -eq 1 ] || usage
  deploy "$1"
fi
