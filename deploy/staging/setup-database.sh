#!/usr/bin/env bash
# Staging database, first time and any time after (idempotent) — docs/99 §4.
#
#   deploy/staging/setup-database.sh
#
# 1. Makes the five database passwords and the backup passphrase if they do not exist yet (openssl, hex, mode 600,
#    in STAGING_SECRETS_DIR — outside the checkout, never printed, never typed by a person).
# 2. Writes the two connection files the stack reads from them: database.env (the API, as phonestore_app) and
#    migrator.env (the one-off migration, as phonestore_migrator). The API never receives the migrator's password.
# 3. Starts MySQL, waits until it answers, and creates the four identities (deploy/mysql-identities.sql) and the
#    staging schema with their grants (grants-staging.sql). Nothing is migrated here: that is migrate.sh.
source "$(dirname "$0")/lib.sh"

umask 077
mkdir -p "$STAGING_SECRETS_DIR" "$STAGING_BACKUP_DIR"
for name in mysql_root migrator app backup admin; do
  [ -s "$STAGING_SECRETS_DIR/$name.pw" ] || openssl rand -hex 24 > "$STAGING_SECRETS_DIR/$name.pw"
done
[ -s "$STAGING_SECRETS_DIR/backup-passphrase" ] || openssl rand -base64 48 > "$STAGING_SECRETS_DIR/backup-passphrase"

APP_PW=$(cat "$STAGING_SECRETS_DIR/app.pw")
MIGRATOR_PW=$(cat "$STAGING_SECRETS_DIR/migrator.pw")
printf 'APP_DATABASE_URL=mysql://phonestore_app:%s@db:3306/phonestore_staging?connection_limit=10\n' "$APP_PW" > "$STAGING_SECRETS_DIR/database.env"
# The operator tools read DATABASE_URL; for them it is the app identity too (DML only, triggers enforced).
printf 'DATABASE_URL=mysql://phonestore_app:%s@db:3306/phonestore_staging\n' "$APP_PW" >> "$STAGING_SECRETS_DIR/database.env"
printf 'DATABASE_URL=mysql://phonestore_migrator:%s@db:3306/phonestore_staging\n' "$MIGRATOR_PW" > "$STAGING_SECRETS_DIR/migrator.env"
chmod 600 "$STAGING_SECRETS_DIR"/*
chmod 700 "$STAGING_SECRETS_DIR"

echo "== MySQL"
compose up -d db
wait_healthy db 240
db_root -e "SELECT 'mysql', VERSION(), @@sql_mode, @@time_zone, @@log_bin_trust_function_creators, @@character_set_server"

echo "== identities and the staging schema"
{ printf "SET @migrator_pw='%s', @app_pw='%s', @backup_pw='%s', @admin_pw='%s';\n" \
    "$MIGRATOR_PW" "$APP_PW" "$(cat "$STAGING_SECRETS_DIR/backup.pw")" "$(cat "$STAGING_SECRETS_DIR/admin.pw")"
  cat "$DEPLOY_DIR/mysql-identities.sql" "$STAGING_DIR/grants-staging.sql"; } | db_root
db_root -e "SELECT user, host FROM mysql.user WHERE user LIKE 'phonestore\\_%' ORDER BY user"
echo "Database ready. Next: deploy/staging/migrate.sh"
