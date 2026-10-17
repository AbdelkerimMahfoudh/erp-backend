#!/usr/bin/env bash
# Restore a backup into a throw-away copy and prove it is whole (docs/99 §7; deploy/restore-drill.sh, docs/22 §3).
#
#   deploy/staging/restore-drill.sh                       # the newest backup
#   deploy/staging/restore-drill.sh phonestore_staging-20261017T150000Z.sql.gz.enc
#
# The live schema is never touched: the copy is phonestore_staging_drill_<stamp>, compared table by table (row counts,
# checksums, trigger bodies) with the live schema, then dropped. Run as phonestore_admin inside the database container.
source "$(dirname "$0")/lib.sh"
name=${1:-$(ls -1t "$STAGING_BACKUP_DIR"/*.sql.gz.enc 2>/dev/null | head -n 1 | xargs -r basename)}
[ -n "$name" ] || { echo "No backup in $STAGING_BACKUP_DIR. Run backup.sh first." >&2; exit 2; }
compose exec -T -e BACKUP_NAME="$name" db bash -c 'BACKUP=/backups/$BACKUP_NAME BACKUP_PASSPHRASE_FILE=/secrets/backup-passphrase \
  MYSQL_PWD_FILE=/secrets/admin.pw MYSQL_USER=phonestore_admin SOURCE_DB=phonestore_staging APP_PW="$(cat /secrets/app.pw)" \
  MYSQL_SOCKET=/var/run/mysqld/mysqld.sock bash /deploy/restore-drill.sh'
