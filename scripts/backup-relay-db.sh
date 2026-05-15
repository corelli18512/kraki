#!/bin/sh
# WAL-safe daily backup of the kraki-relay SQLite DB.
#
# Usage (run as root, typically from /etc/cron.daily):
#   backup-relay-db.sh
#
# Behaviour:
#   - Uses sqlite3 .backup (NOT cp) so it's safe to run while the relay is live.
#   - Writes /root/kraki-backups/kraki-relay-YYYYMMDD.db (overwrites if same day).
#   - Verifies the backup with PRAGMA integrity_check; refuses to retain a corrupt copy.
#   - Deletes backups older than 14 days.

set -eu

DB=/var/lib/kraki/kraki-relay.db
BACKUP_DIR=/root/kraki-backups
RETENTION_DAYS=14

if [ ! -f "$DB" ]; then
  echo "DB not found: $DB" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not installed" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date +%Y%m%d)
OUT="$BACKUP_DIR/kraki-relay-$STAMP.db"
TMP="$OUT.tmp"

# WAL-safe online backup.
sqlite3 "$DB" ".backup '$TMP'"

# Integrity check before promoting.
RESULT=$(sqlite3 "$TMP" "PRAGMA integrity_check;" 2>&1 || true)
if [ "$RESULT" != "ok" ]; then
  echo "integrity check failed for $TMP:" >&2
  echo "$RESULT" >&2
  rm -f "$TMP"
  exit 1
fi

mv -f "$TMP" "$OUT"
chmod 600 "$OUT"

# Retention sweep: drop daily backups older than RETENTION_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'kraki-relay-*.db' -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true

echo "backup ok: $OUT"
