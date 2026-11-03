#!/usr/bin/env bash
# Run on the OPERATOR'S machine (D227): production's exact schema for the migration rehearsal, read-only.
#
#   deploy/production/schema-for-rehearsal.sh <ssh-host> <local-directory>
#
# Reads, never writes: mysqldump runs inside the database container as phonestore_backup, the read-only account the
# backups use, over the local socket. It takes the structure only (tables, triggers, routines, events) and the rows of
# `_prisma_migrations`, so the rehearsal knows which migrations production has. No business row and no personal data
# leaves the server. It takes no lock and changes nothing on the host. The output is two plain files and their
# checksums, kept in the operator's local directory and outside every repository:
#   prod-schema-<UTC>.sql      → PROD_SCHEMA for deploy/rehearse-migrations.sh
#   prod-migrations-<UTC>.txt  → the applied migrations, for the record
set -euo pipefail

die() { echo "Refusing: $*" >&2; exit 2; }
HOST=${1:-}
DEST=${2:-}
[ -n "$HOST" ] || die "name the ssh host."
[ -n "$DEST" ] && [ -d "$DEST" ] || die "name an existing local directory."
REMOTE=${REMOTE_CHECKOUT:-/srv/erp-production/erp-backend}
SSH=${SSH_BIN:-ssh}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SCHEMA=$DEST/prod-schema-$STAMP.sql
MIGRATIONS=$DEST/prod-migrations-$STAMP.txt

# One command on the host: the read-only account, the production project's own compose wrapper, and nothing written.
dump() {
  "$SSH" -o BatchMode=yes "$HOST" "cd '$REMOTE' && sudo -n bash -c 'source deploy/production/lib.sh >/dev/null && compose exec -T db sh -c \"MYSQL_PWD=\\\"\\\$(cat /secrets/backup.pw)\\\" exec mysqldump --socket=/var/run/mysqld/mysqld.sock -u phonestore_backup --single-transaction --no-tablespaces --hex-blob --set-gtid-purged=OFF --skip-dump-date $1 phonestore $2\"'" < /dev/null
}

dump "--no-data --routines --triggers --events" "" > "$SCHEMA.part"
grep -q '^-- Dump completed' "$SCHEMA.part" || die "the schema dump did not complete."
# The applied migrations: one table, its rows only, appended so the rehearsal starts exactly where production is.
dump "--no-create-info --skip-triggers" "_prisma_migrations" >> "$SCHEMA.part"
mv -f "$SCHEMA.part" "$SCHEMA"
grep -oE "'[0-9]{4}_[a-z0-9_]+'" "$SCHEMA" | tr -d "'" | sort -u > "$MIGRATIONS"
grep -qiE 'INSERT INTO `(users|companies|sales|customers)`' "$SCHEMA" && die "business rows reached the schema file; delete it."

(cd "$DEST" && sha256sum "$(basename "$SCHEMA")" "$(basename "$MIGRATIONS")")
echo "schema: $(grep -c '^CREATE TABLE' "$SCHEMA") tables, $(grep -c 'CREATE.*TRIGGER' "$SCHEMA") triggers; production's last migration: $(tail -n 1 "$MIGRATIONS")"
