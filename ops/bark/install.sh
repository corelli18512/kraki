#!/bin/sh
# Root on the target host. Binary is fetched separately from Finb/bark-server,
# pinned and verified here. Only Bark is (re)started; no proxy/relay changes.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
VERSION=v2.3.9
[ "$(id -u)" = 0 ] || { echo 'run as root' >&2; exit 1; }
[ "$#" = 1 ] || { echo "usage: $0 /path/to/bark-server_linux_<arch>" >&2; exit 2; }
case "$(uname -m)" in
  aarch64) SHA=9b8470cce74ab7295890c2684da3d565bdf78adf8dd16174fb41311df6d84d95 ;;
  x86_64) SHA=aaede9e304524550ad8b11ea8ae99fa0a84145064d128a211f4437374ece97a9 ;;
  *) echo 'unsupported architecture' >&2; exit 1 ;;
esac
printf '%s  %s\n' "$SHA" "$1" | sha256sum -c -
getent passwd kraki-bark >/dev/null || useradd --system --user-group --home-dir /var/lib/kraki-bark --shell /usr/sbin/nologin kraki-bark
RELEASE=/opt/kraki-bark/releases/$VERSION
install -d -m 755 "$RELEASE"
# Never overwrite a running release in place; refuse unexpected existing bytes.
if [ -f "$RELEASE/bark-server" ]; then
  printf '%s  %s\n' "$SHA" "$RELEASE/bark-server" | sha256sum -c -
else
  install -m 755 "$1" "$RELEASE/bark-server"
fi
OLD=$(readlink /opt/kraki-bark/current || true)
BACKUP=/var/backups/kraki-bark/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$BACKUP"
[ ! -f /etc/systemd/system/kraki-bark.service ] || cp -a /etc/systemd/system/kraki-bark.service "$BACKUP/kraki-bark.service"
printf '%s\n' "$OLD" > "$BACKUP/previous-release"
ln -sfn "$RELEASE" /opt/kraki-bark/current
install -m 644 "$HERE/bark.service" /etc/systemd/system/kraki-bark.service
systemd-analyze verify /etc/systemd/system/kraki-bark.service
systemctl daemon-reload
systemctl enable kraki-bark.service
systemctl restart kraki-bark.service
for unused in 1 2 3 4 5; do
  if curl -fsS --max-time 3 http://127.0.0.1:4080/bark/ping | grep -q '"message":"pong"'; then
    echo "Bark $VERSION ready on loopback; rollback metadata: $BACKUP"
    exit 0
  fi
  sleep 1
done
echo "Bark health check failed; inspect systemctl status. Previous release: $OLD; metadata: $BACKUP" >&2
exit 1
