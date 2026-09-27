#!/bin/bash
# Explicit operator-authorized deployment. Does not restart/upgrade Head.
# Usage: deploy-sidecar.sh ssh-host absolute-node absolute-head-db user nginx|caddy proxy-config
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${1:?host}"; NODE="${2:?node}"; DB="${3:?db}"; USER_NAME="${4:?user}"
PROXY="${5:?nginx|caddy}"; CONFIG="${6:?proxy config}"
REV="$(git -C "$ROOT" rev-parse HEAD)"
for value in "$NODE" "$DB" "$CONFIG"; do [[ "$value" =~ ^/[a-zA-Z0-9_./-]+$ ]] || exit 2; done
[[ "$USER_NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
[[ "$PROXY" = nginx || "$PROXY" = caddy ]] || exit 2
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kraki-diag-deploy.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp "$ROOT/packages/head/dist/diag-api.js" "$ROOT/packages/head/dist/diag-sidecar.js" "$STAGE/"
printf '{"type":"module"}\n' > "$STAGE/package.json"
tar -czf "$STAGE/service.tgz" -C "$STAGE" diag-api.js diag-sidecar.js package.json
scp "$STAGE/service.tgz" "$HOST:/tmp/kraki-diag-$REV.tgz"
ssh "$HOST" sudo bash -s -- "$REV" "$NODE" "$DB" "$USER_NAME" "$PROXY" "$CONFIG" <<'REMOTE'
set -euo pipefail
REV="$1"; NODE="$2"; DB="$3"; USER_NAME="$4"; PROXY="$5"; CONFIG="$6"
BEFORE_PID="$(systemctl show kraki-relay -p MainPID --value)"
RELEASE="/opt/kraki-diag/releases/$REV"
BACKUP="/var/backups/kraki-diag/$REV"
install -d -m 0755 "$RELEASE"
install -d -m 0700 "$BACKUP"
install -d -m 0700 -o "$USER_NAME" -g "$(id -gn "$USER_NAME")" /var/lib/kraki-diag
cp -p "$CONFIG" "$BACKUP/proxy.conf"
if [ -f /etc/systemd/system/kraki-diag.service ]; then cp -p /etc/systemd/system/kraki-diag.service "$BACKUP/service.unit"; fi
tar -xzf "/tmp/kraki-diag-$REV.tgz" -C "$RELEASE"
cat > /etc/systemd/system/kraki-diag.service <<UNIT
[Unit]
Description=Kraki independent client diagnostics REST collector
After=network.target
[Service]
Type=simple
User=$USER_NAME
ExecStart=$NODE --max-old-space-size=64 $RELEASE/diag-sidecar.js
Environment=KRAKI_DIAG_DB=$DB
Environment=KRAKI_DIAG_DIR=/var/lib/kraki-diag
Environment=KRAKI_DIAG_PORT=4011
Environment=KRAKI_DIAG_REVISION=$REV
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/kraki-diag
Nice=15
CPUWeight=10
MemoryMax=128M
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable kraki-diag
systemctl restart kraki-diag
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4011/health > "$BACKUP/health.json"; then break; fi
  sleep 1
done
grep -q "$REV" "$BACKUP/health.json"
python3 - "$CONFIG" "$PROXY" <<'PY'
import pathlib,sys
path=pathlib.Path(sys.argv[1]); kind=sys.argv[2]; text=path.read_text()
if '/api/diag/v1/' not in text:
    if kind=='nginx':
        needle='    location / {\n        proxy_pass http://127.0.0.1:4000;'
        addition='''    # Independent log collector; WebSocket/Head routing stays unchanged.
    location ^~ /api/diag/v1/ {
        proxy_pass http://127.0.0.1:4011;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        client_max_body_size 64k;
        proxy_read_timeout 20s;
        proxy_send_timeout 20s;
        access_log off;
    }

'''
        assert text.count(needle)==1, 'Unrecognized nginx relay block; no edit'
        text=text.replace(needle,addition+needle)
    else:
        needle='relay.kraki.chat {\n\treverse_proxy localhost:4000'
        replacement='relay.kraki.chat {\n\t@diagnostics path /api/diag/v1/*\n\treverse_proxy @diagnostics 127.0.0.1:4011\n\treverse_proxy localhost:4000'
        assert text.count(needle)==1, 'Unrecognized Caddy relay block; no edit'
        text=text.replace(needle,replacement)
    path.write_text(text)
PY
if [ "$PROXY" = nginx ]; then
  if ! nginx -t; then cp "$BACKUP/proxy.conf" "$CONFIG"; exit 1; fi
  systemctl reload nginx
else
  if ! caddy validate --config "$CONFIG" --adapter caddyfile; then cp "$BACKUP/proxy.conf" "$CONFIG"; exit 1; fi
  systemctl reload caddy
fi
test "$(systemctl show kraki-relay -p MainPID --value)" = "$BEFORE_PID"
systemctl is-active kraki-diag kraki-relay
curl -fsS http://127.0.0.1:4011/health
printf '\nHead PID unchanged: %s; proxy backup: %s\n' "$BEFORE_PID" "$BACKUP"
REMOTE
