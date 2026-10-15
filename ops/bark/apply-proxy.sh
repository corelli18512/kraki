#!/bin/sh
# Explicitly authorized deployment step: backup, validate and reload ONE proxy.
# Does not restart the proxy or relay. Clients may briefly reconnect on reload.
set -eu
[ "$(id -u)" = 0 ] || { echo 'run as root' >&2; exit 1; }
KIND=${1:-}
case "$KIND" in
  caddy) CONFIG=/etc/caddy/Caddyfile ;;
  nginx) CONFIG=$(readlink -f /etc/nginx/sites-enabled/cn.relay.kraki.chat) ;;
  *) echo "usage: $0 <caddy|nginx>" >&2; exit 2 ;;
esac
HERE=$(cd "$(dirname "$0")" && pwd)
BACKUP=/var/backups/kraki-bark/$(date -u +%Y%m%dT%H%M%SZ)-proxy
install -d -m 700 "$BACKUP"
cp -a "$CONFIG" "$BACKUP/original"
CANDIDATE=$(mktemp "$(dirname "$CONFIG")/.kraki-bark.XXXXXX")
CHANGED=0
rollback() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$CHANGED" = 1 ]; then
    cp -a "$BACKUP/original" "$CANDIDATE"
    mv -f "$CANDIDATE" "$CONFIG"
    systemctl reload "$KIND" || true
    echo "restored proxy config after failure; backup: $BACKUP" >&2
  fi
  [ ! -f "$CANDIDATE" ] || rm -f "$CANDIDATE"
  exit "$rc"
}
trap rollback 0
trap 'exit 1' HUP INT TERM
python3 "$HERE/proxy-config.py" "$KIND" "$CONFIG" > "$CANDIDATE"
if [ "$KIND" = caddy ]; then caddy validate --config "$CANDIDATE" --adapter caddyfile; fi
cmp -s "$CONFIG" "$BACKUP/original" || { echo 'proxy config changed concurrently; aborting' >&2; exit 1; }
chmod --reference="$CONFIG" "$CANDIDATE"
chown --reference="$CONFIG" "$CANDIDATE"
CHANGED=1
mv -f "$CANDIDATE" "$CONFIG"
# nginx validates its full include tree; running workers are unchanged so far.
if [ "$KIND" = nginx ]; then nginx -t; fi
systemctl reload "$KIND"
echo "proxy reloaded; backup: $BACKUP"
