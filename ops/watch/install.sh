#!/bin/sh
# Install or update kraki-watch on a relay host. Run as root:
#   sh install.sh <tokyo|cn> [--with-backup] [--with-journal-policy]
#
# Idempotent. Installs into /opt/kraki-watch and systemd; never touches the
# relay itself. A fresh install starts in shadow mode (KRAKI_WATCH_NOTIFY=0):
# it logs what it would send (journalctl -u kraki-watch) until you set
# KRAKI_WATCH_NOTIFY=1 in /etc/kraki/watch.env.
set -eu

HOST=${1:-}
[ "$HOST" = tokyo ] || [ "$HOST" = cn ] || { echo "usage: $0 <tokyo|cn> [--with-backup] [--with-journal-policy]" >&2; exit 2; }
shift
WITH_BACKUP=0
WITH_JOURNAL=0
for arg in "$@"; do
  case "$arg" in
    --with-backup) WITH_BACKUP=1 ;;
    --with-journal-policy) WITH_JOURNAL=1 ;;
    *) echo "unknown option" >&2; exit 2 ;;
  esac
done
# Check optional dependencies before making any changes.
if [ "$WITH_BACKUP" = 1 ]; then command -v sqlite3 >/dev/null || { echo "sqlite3 missing" >&2; exit 1; }; fi
HERE=$(cd "$(dirname "$0")" && pwd)

# Node >= 20 for fetch/statfs: the relay's own runtime if present, else the system node.
NODE=""
for cand in /opt/kraki-head/runtimes/node-v24*/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$cand" ] && "$cand" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then NODE=$cand; break; fi
done
[ -n "$NODE" ] || { echo "node >= 20 not found" >&2; exit 1; }

install -d -m 755 /opt/kraki-watch /opt/kraki-watch/lib
install -m 644 "$HERE"/lib/*.mjs /opt/kraki-watch/lib/
install -m 755 "$HERE/kraki-watch.mjs" /opt/kraki-watch/kraki-watch.mjs
install -m 755 "$HERE/../../scripts/backup-relay-db.sh" /opt/kraki-watch/backup-relay-db.sh
ln -sfn "$NODE" /opt/kraki-watch/node
cat > /usr/local/bin/kraki-watch <<WRAP
#!/bin/sh
set -a; [ -f /etc/kraki/watch.env ] && . /etc/kraki/watch.env; set +a
exec /opt/kraki-watch/node /opt/kraki-watch/kraki-watch.mjs "\$@"
WRAP
chmod 755 /usr/local/bin/kraki-watch

install -d -m 755 /etc/kraki
install -m 644 "$HERE/config/$HOST.json" /etc/kraki/watch.json
if [ ! -f /etc/kraki/watch.env ]; then
  install -m 600 "$HERE/watch.env.example" /etc/kraki/watch.env
  echo "created /etc/kraki/watch.env (shadow mode); fill in BARK_KEY / HC_PING_URL"
fi
install -d -m 700 /var/lib/kraki-watch

install -m 644 "$HERE/systemd/kraki-watch.service" "$HERE/systemd/kraki-watch.timer" /etc/systemd/system/
for unit in $("$NODE" -e 'for (const u of require("/etc/kraki/watch.json").units) console.log(u.unit)'); do
  install -d -m 755 "/etc/systemd/system/$unit.service.d"
  install -m 644 "$HERE/systemd/watch-on-failure.conf" "/etc/systemd/system/$unit.service.d/kraki-watch.conf"
done
if [ "$WITH_JOURNAL" = 1 ]; then
  install -d -m 755 /etc/systemd/journald.conf.d
  install -m 644 "$HERE/systemd/journald-kraki.conf" /etc/systemd/journald.conf.d/kraki.conf
fi

if [ "$WITH_BACKUP" = 1 ]; then
  install -m 644 "$HERE/systemd/kraki-backup.service" "$HERE/systemd/kraki-backup.timer" /etc/systemd/system/
fi

systemctl daemon-reload
if [ "$WITH_JOURNAL" = 1 ]; then systemctl restart systemd-journald; fi
systemctl enable --now kraki-watch.timer
if [ "$WITH_BACKUP" = 1 ]; then systemctl enable --now kraki-backup.timer; fi
echo "kraki-watch installed for $HOST (node: $NODE)"
