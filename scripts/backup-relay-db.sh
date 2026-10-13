#!/bin/sh
# WAL-safe daily backup of the kraki-relay SQLite DB.
#
# Usage (run as root, from kraki-backup.timer; see ops/watch/README.md):
#   backup-relay-db.sh
#
# Environment (all optional; defaults match the original China relay layout):
#   KRAKI_DB              database file           (/var/lib/kraki/kraki-relay.db)
#   KRAKI_BACKUP_DIR      where backups are kept  (/root/kraki-backups)
#   KRAKI_BACKUP_DAYS     retention in days       (14)
#   KRAKI_BACKUP_REMOTE   off-site copy target, user@host:dir (unset = no copy)
#   KRAKI_BACKUP_SSH_KEY  key for the copy        (/root/.ssh/kraki-backup)
#   KRAKI_BACKUP_STATUS   status JSON for kraki-watch (/var/lib/kraki-watch/backup.json)
#   KRAKI_BACKUP_INCOMING copies received from the other relay; swept with the same retention
#
# Behaviour:
#   - Uses sqlite3 .backup (NOT cp) so it's safe to run while the relay is live.
#   - Verifies the backup with PRAGMA integrity_check; refuses to retain a corrupt copy.
#   - Writes kraki-relay-YYYYMMDD.db (overwrites if same day), gzip'd copy goes off-site.
#   - Deletes backups older than the retention.
#   - Always writes the status file, success or failure, so a broken backup alerts.

set -eu

DB=${KRAKI_DB:-/var/lib/kraki/kraki-relay.db}
BACKUP_DIR=${KRAKI_BACKUP_DIR:-/root/kraki-backups}
RETENTION_DAYS=${KRAKI_BACKUP_DAYS:-14}
REMOTE=${KRAKI_BACKUP_REMOTE:-}
SSH_KEY=${KRAKI_BACKUP_SSH_KEY:-/root/.ssh/kraki-backup}
STATUS=${KRAKI_BACKUP_STATUS:-/var/lib/kraki-watch/backup.json}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# JSON string body: escape backslash and quote, drop control characters.
json_str() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-400; }

write_status() {
  # $1 = JSON body (without braces)
  mkdir -p "$(dirname "$STATUS")"
  printf '{%s}\n' "$1" > "$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"
}

PREV_SIZE=0
if [ -f "$STATUS" ]; then
  # Last good size: sizeBytes after a success, carried as prevSizeBytes after a failure.
  PREV_SIZE=$(sed -n 's/.*"sizeBytes":\([0-9]*\).*/\1/p' "$STATUS" | head -1)
  [ -n "$PREV_SIZE" ] || PREV_SIZE=$(sed -n 's/.*"prevSizeBytes":\([0-9]*\).*/\1/p' "$STATUS" | head -1)
  PREV_SIZE=${PREV_SIZE:-0}
fi

STATUS_WRITTEN=0
fail() {
  echo "$1" >&2
  write_status "\"ok\":false,\"at\":\"$(now_iso)\",\"error\":\"$(json_str "$1")\",\"prevSizeBytes\":$PREV_SIZE"
  STATUS_WRITTEN=1
  exit 1
}
# Any other failure (set -e: mkdir, mv, chmod, …) must not leave the previous
# success standing.
on_exit() {
  rc=$?
  [ -n "${SCP_ERR:-}" ] && rm -f "$SCP_ERR"
  if [ "$rc" -ne 0 ] && [ "$STATUS_WRITTEN" -eq 0 ]; then
    write_status "\"ok\":false,\"at\":\"$(now_iso)\",\"error\":\"backup script exited with $rc\",\"prevSizeBytes\":$PREV_SIZE" || true
  fi
}
trap on_exit EXIT

[ -f "$DB" ] || fail "DB not found: $DB"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 not installed"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date +%Y%m%d)
OUT="$BACKUP_DIR/kraki-relay-$STAMP.db"
TMP="$OUT.tmp"

# WAL-safe online backup.
sqlite3 "$DB" ".backup '$TMP'" || { rm -f "$TMP"; fail "sqlite3 .backup failed"; }

# Integrity check before promoting.
RESULT=$(sqlite3 "$TMP" "PRAGMA integrity_check;" 2>&1 || true)
if [ "$RESULT" != "ok" ]; then
  rm -f "$TMP"
  fail "integrity check failed: $RESULT"
fi

mv -f "$TMP" "$OUT"
chmod 600 "$OUT"
SIZE=$(wc -c < "$OUT" | tr -d ' ')

# Retention sweep: drop daily backups older than RETENTION_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'kraki-relay-*.db*' -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true
if [ -n "${KRAKI_BACKUP_INCOMING:-}" ] && [ -d "$KRAKI_BACKUP_INCOMING" ]; then
  find "$KRAKI_BACKUP_INCOMING" -maxdepth 1 -type f -name 'kraki-relay-*.db.gz' -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true
fi

COPIED=null
COPY_ERROR=""
if [ -n "$REMOTE" ]; then
  SCP_ERR=$(mktemp "$BACKUP_DIR/.scp-err.XXXXXX")
  if ! gzip -kf "$OUT" 2>"$SCP_ERR"; then
    COPIED=false
    COPY_ERROR="gzip failed: $(cat "$SCP_ERR")"
  elif scp -q -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=20 "$OUT.gz" "$REMOTE/" 2>"$SCP_ERR"; then
    COPIED=true
  else
    COPIED=false
    COPY_ERROR=$(cat "$SCP_ERR")
  fi
  rm -f "$OUT.gz" "$SCP_ERR"
fi

write_status "\"ok\":true,\"at\":\"$(now_iso)\",\"file\":\"$(json_str "$OUT")\",\"sizeBytes\":$SIZE,\"prevSizeBytes\":$PREV_SIZE,\"copied\":$COPIED,\"copyError\":\"$(json_str "$COPY_ERROR")\""
STATUS_WRITTEN=1
echo "backup ok: $OUT ($SIZE bytes, copied=$COPIED)"
