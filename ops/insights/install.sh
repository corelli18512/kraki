#!/bin/sh
# Explicitly authorized, independent service only. No relay restart or DB write.
set -eu
HOST=${1:?usage: install.sh tokyo|cn}
case "$HOST" in tokyo) DB=/home/ubuntu/kraki-head.db; PRIMARY=true;; cn) DB=/var/lib/kraki/kraki-relay.db; PRIMARY=false;; *) exit 2;; esac
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ -s /etc/kraki/insights-hmac.key ] || { echo 'Provision the same private 32-byte HMAC key on both hosts first' >&2; exit 1; }
python3 - <<'PY'
import os,stat
p='/etc/kraki/insights-hmac.key'
s=os.stat(p)
assert s.st_uid == 0 and not stat.S_IMODE(s.st_mode) & 0o077 and s.st_size >= 32, 'HMAC key must be private, root-owned, at least 32 bytes'
PY
install -d -m 0755 /opt/kraki-insights
install -d -m 0700 /var/lib/kraki-insights
for file in run.py indexer.py product.py metrics.py; do install -m 0644 "$DIR/$file" "/opt/kraki-insights/$file"; done
install -m 0755 "$DIR/export" /opt/kraki-insights/export
if [ ! -e /etc/kraki/insights.json ]; then
  (umask 077; printf '{"host":"%s","primary":%s,"headDb":"%s","hmacKeyFile":"/etc/kraki/insights-hmac.key","diagDirectory":"/var/lib/kraki-diag","stateDirectory":"/var/lib/kraki-insights"}\n' "$HOST" "$PRIMARY" "$DB" > /etc/kraki/insights.json)
fi
install -m 0644 "$DIR/kraki-insights.service" /etc/systemd/system/kraki-insights.service
install -m 0644 "$DIR/kraki-insights.timer" /etc/systemd/system/kraki-insights.timer
systemctl daemon-reload
systemctl enable --now kraki-insights.timer
printf 'Installed independent insights job. Configure restricted peer access before claiming global DAU. Relay was not restarted.\n'
