#!/usr/bin/env bash
# ICOS durable-state backup. Read-only on every source; writes only under $BACKUP_ROOT.
#
#   - app PostgreSQL   (container icos-app-postgres, db icos_app)      → pg_dump -Fc
#   - Temporal state   (container icos-test-postgres, dbs temporal, temporal_visibility)
#   - OmniRoute SQLite (~/.omniroute/storage.sqlite) → SQLite online-backup API, readonly
#     handle: the live database is never written, migrated or locked for writers.
#
# No secret is copied: env files and credential stores are deliberately NOT backed up here
# (they are restored by the owner, never by automation). Dumps are mode 600.
set -euo pipefail
umask 077

BACKUP_ROOT="${BACKUP_ROOT:-/srv/icos/backups/daily}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
APP_PG="${APP_PG:-icos-app-postgres}"
TEMPORAL_PG="${TEMPORAL_PG:-icos-test-postgres}"
OMNI_DB="${OMNI_DB:-/home/icos/.omniroute/storage.sqlite}"
OMNI_SQLITE_MODULE="${OMNI_SQLITE_MODULE:-/home/icos/.omniroute/runtime/node_modules/better-sqlite3}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dir="$BACKUP_ROOT/$stamp"
mkdir -p "$dir"
# On any failure the incomplete run is marked, so retention and restores never mistake it.
trap 'rc=$?; [[ $rc -ne 0 ]] && touch "$dir/FAILED"; exit $rc' EXIT

dump() { # container user db
  # Written under a temporary name: a failed dump never leaves a file that looks like a backup.
  docker exec "$1" pg_dump -U "$2" -d "$3" -Fc > "$dir/$3.dump.partial"
  # A dump pg_restore cannot list is not a backup.
  docker exec -i "$1" pg_restore --list < "$dir/$3.dump.partial" > /dev/null
  mv "$dir/$3.dump.partial" "$dir/$3.dump"
  echo "pg  $3 $(stat -c %s "$dir/$3.dump") bytes"
}

dump "$APP_PG" icos_app icos_app
dump "$TEMPORAL_PG" icos temporal
dump "$TEMPORAL_PG" icos temporal_visibility

if [[ -f "$OMNI_DB" && -d "$OMNI_SQLITE_MODULE" ]]; then
  node -e '
    const Database = require(process.argv[1]);
    const src = new Database(process.argv[2], { readonly: true, fileMustExist: true });
    src.backup(process.argv[3]).then(() => {
      const copy = new Database(process.argv[3], { readonly: true });
      const ok = copy.pragma("integrity_check", { simple: true });
      if (ok !== "ok") { console.error("integrity_check:", ok); process.exit(1); }
      console.log("sqlite omniroute ok");
    }).catch((e) => { console.error(e.message); process.exit(1); });
  ' "$OMNI_SQLITE_MODULE" "$OMNI_DB" "$dir/omniroute-storage.sqlite"
fi

( cd "$dir" && sha256sum -- * > SHA256SUMS )
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf -- {} +
echo "backup complete: $dir"
