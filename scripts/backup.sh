#!/bin/bash
#
# Croft backup. Configure with environment variables and run from cron.
#
#   CROFT_BACKUP_DIR     where to write backups (default: /srv/backups/croft)
#   CROFT_DB_CONTAINER   Postgres container name (default: croft-postgres)
#   CROFT_DB_USER        Postgres role for pg_dump (default: postgres)
#   CROFT_ATTACHMENT_DIR attachment tree (default: /srv/croft/attachments)
#
# Backs up BOTH halves, because either alone is useless: a database dump
# without the storage tree loses every attachment, and the storage tree
# without the dump loses every reference to those files.
#
# Retention: 7 daily, 4 weekly (Sundays).
#
set -euo pipefail

DEST=${CROFT_BACKUP_DIR:-/srv/backups/croft}
DB_CONTAINER=${CROFT_DB_CONTAINER:-croft-postgres}
DB_NAME=${CROFT_DB_NAME:-croft}
DB_USER=${CROFT_DB_USER:-postgres}
ATTACHMENTS=${CROFT_ATTACHMENT_DIR:-/srv/croft/attachments}

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DOW=$(date -u +%u)

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

mkdir -p "$DEST/daily" "$DEST/weekly" || fail "cannot create $DEST"

DUMP="$DEST/daily/croft-db-$STAMP.dump"
TMP="$DUMP.tmp"
FILES="$DEST/daily/croft-storage-$STAMP.tar.gz"
trap 'rm -f "$TMP"' EXIT

log "starting backup $STAMP"

# Public is the complete application database. Supabase-owned schemas, roles,
# owners and grants are deliberately excluded so the dump is stock-PG portable.
if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc \
      --schema=public --no-owner --no-privileges > "$TMP"; then
  fail "pg_dump failed"
fi
mv "$TMP" "$DUMP"

SIZE=$(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP")
[ "$SIZE" -gt 1024 ] || fail "dump is implausibly small ($SIZE bytes)"
log "database dumped ($SIZE bytes)"

mkdir -p "$ATTACHMENTS"
if ! tar -czf "$FILES" -C "$ATTACHMENTS" .; then
  rm -f "$FILES"
  fail "storage archive failed"
fi
log "storage archived"

# Checksums, so silent corruption is detectable later.
(cd "$DEST/daily" && sha256sum "$(basename "$DUMP")" "$(basename "$FILES")" >> SHA256SUMS)

[ "$DOW" = "7" ] && cp -p "$DUMP" "$FILES" "$DEST/weekly/" && log "promoted to weekly"

find "$DEST/daily"  -name 'croft-db-*.dump'        -mtime +7  -delete
find "$DEST/daily"  -name 'croft-storage-*.tar.gz' -mtime +7  -delete
find "$DEST/weekly" -name 'croft-*'                -mtime +28 -delete

log "backup $STAMP complete"
