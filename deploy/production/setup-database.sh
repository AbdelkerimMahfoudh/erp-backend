#!/usr/bin/env bash
# The database server, the schema and the four identities, first time and any time after (idempotent) — docs/100 §4.
#
#   deploy/production/setup-database.sh
#
# Starts MySQL, waits until it answers, creates the `phonestore` schema, then runs the CI-gated identity file
# (deploy/mysql-identities.sql) unchanged: phonestore_migrator (DDL), phonestore_app (DML only; the audit triggers
# check this exact name), phonestore_backup (read-only, local socket only), phonestore_admin (operator, local only).
# Nothing is migrated here: that is migrate.sh. The passwords travel on standard input, never on a command line.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
for name in mysql_root migrator app backup admin; do
  [ -s "$SECRETS_DIR/db/$name.pw" ] || die "missing $SECRETS_DIR/db/$name.pw — run setup-secrets.sh first."
done

echo "== MySQL ($PROJECT)"
compose up -d db
wait_healthy db 240
db_root -e "SELECT 'mysql', VERSION(), @@sql_mode, @@time_zone, @@log_bin_trust_function_creators, @@character_set_server, @@innodb_buffer_pool_size DIV 1048576"

echo "== the schema and the identities"
{ printf "SET @migrator_pw='%s', @app_pw='%s', @backup_pw='%s', @admin_pw='%s';\n" \
    "$(cat "$SECRETS_DIR/db/migrator.pw")" "$(cat "$SECRETS_DIR/db/app.pw")" \
    "$(cat "$SECRETS_DIR/db/backup.pw")" "$(cat "$SECRETS_DIR/db/admin.pw")"
  cat "$PRODUCTION_DIR/schema.sql" "$DEPLOY_DIR/mysql-identities.sql"; } | db_root
db_root -e "SELECT CONCAT(user, '@', host) FROM mysql.user WHERE user LIKE 'phonestore\\_%' OR user = 'root' ORDER BY user"
echo "Database ready. Next: deploy/production/migrate.sh --confirm $API_HOST"
