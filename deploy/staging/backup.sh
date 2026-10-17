#!/usr/bin/env bash
# An encrypted, verified backup of the staging schema (docs/99 §7; deploy/backup-encrypted.sh, docs/22).
#
#   deploy/staging/backup.sh
#
# Runs inside the database container as phonestore_backup (read-only), over the socket. The file lands in
# STAGING_BACKUP_DIR on the host: <db>-<UTC stamp>.sql.gz.enc and its .sha256, the newest 14 kept. Copy them off the
# host (docs/99 §7): a backup on the machine it protects is not a backup.
source "$(dirname "$0")/lib.sh"
compose exec -T db bash -c 'BACKUP_PASSPHRASE_FILE=/secrets/backup-passphrase MYSQL_PWD_FILE=/secrets/backup.pw \
  MYSQL_USER=phonestore_backup DB=phonestore_staging OUT_DIR=/backups MYSQL_SOCKET=/var/run/mysqld/mysqld.sock \
  bash /deploy/backup-encrypted.sh'
