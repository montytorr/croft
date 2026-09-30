#!/bin/bash
# Restore the newest portable dump into a throwaway database and verify both
# database state and the independent attachment archive.
set -euo pipefail

DEST=${CROFT_BACKUP_DIR:-/srv/backups/croft}
DB_CONTAINER=${CROFT_DB_CONTAINER:-croft-postgres}
SCRATCH="croft_restore_drill_$(date -u +%s)"

LATEST=$(find "$DEST/daily" -maxdepth 1 -name 'croft-db-*.dump' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
[ -n "$LATEST" ] || { echo "no dump to restore"; exit 1; }
echo "restoring $(basename "$LATEST")"

q() { docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$1" -qtAX -c "$2"; }
q postgres "create database $SCRATCH owner croft_app" >/dev/null
trap 'q postgres "drop database if exists $SCRATCH with (force)" >/dev/null' EXIT
q "$SCRATCH" 'drop schema public' >/dev/null

docker exec -i "$DB_CONTAINER" pg_restore -U croft_app -d "$SCRATCH" \
  --exit-on-error --no-owner --no-privileges < "$LATEST"

check() {
  local label="$1" sql="$2" got
  got=$(q "$SCRATCH" "$sql")
  echo "  $label: $got"
  [ "$got" != "0" ] && [ "$got" != "f" ] || { echo "DRILL FAILED on $label"; exit 1; }
}

# What every Croft database has from its first day (seeded stages, the first
# administrator), then consistency that holds at any size: a new lab has no
# subjects yet, and a drill that demanded some would fail on a healthy empty one.
check "stages" "select count(*) from public.subject_stages"
check "app users" "select count(*) from public.app_users"
check "subject search vectors" "select count(*) filter (where search_vector is null) = 0 from public.subjects"
check "todo search vectors" "select count(*) filter (where search_vector is null) = 0 from public.tasks"
echo "  subjects: $(q "$SCRATCH" "select count(*) from public.subjects"), todos: $(q "$SCRATCH" "select count(*) from public.tasks")"
LATEST_FILES=$(find "$DEST/daily" -maxdepth 1 -name 'croft-storage-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
[ -n "$LATEST_FILES" ] && tar -tzf "$LATEST_FILES" >/dev/null
echo "  attachment archive: readable"
echo "DRILL PASSED"
