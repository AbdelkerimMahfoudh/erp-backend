#!/usr/bin/env bash
# The stack's generated secrets, first time and any time after (idempotent; an existing secret is never replaced).
#
#   deploy/production/setup-secrets.sh
#
# Writes, under SECRETS_DIR (mode 700, files mode 600, owned by the deployment account — the API container's `node`
# user has the same uid, 1000, so it can read its own files through the read-only mount and nothing else can):
#   db/    mysql_root.pw migrator.pw app.pw backup.pw admin.pw      read by the database container only
#   api/   app_database_url jwt_access_secret otp_pepper messaging_hash_key platform_mfa_key
#          (+ smtp_username smtp_password: the owner's, entered through a hidden prompt — never generated here)
#   database.env   DATABASE_URL as phonestore_app, for the one-off tools container
#   migrator.env   DATABASE_URL as phonestore_migrator, for the one-off migrate container only
#
# Every value comes from openssl's generator straight into its file: never printed, never on a command line, never in
# an environment a person can read. Nothing here is a backup: the database passwords are recreated with the server,
# and the backups' decryption key never lives on it (docs/100 §5).
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"

umask 077
mkdir -p "$SECRETS_DIR/db" "$SECRETS_DIR/api"
chmod 700 "$SECRETS_DIR" "$SECRETS_DIR/db" "$SECRETS_DIR/api"

made=0
new_secret() { # file generator...
  local file=$1; shift
  [ -s "$file" ] && return 0
  "$@" > "$file.tmp"
  [ -s "$file.tmp" ] || { rm -f "$file.tmp"; echo "could not generate $(basename "$file")" >&2; exit 1; }
  mv -f "$file.tmp" "$file"; made=$((made + 1))
}
for name in mysql_root migrator app backup admin; do new_secret "$SECRETS_DIR/db/$name.pw" openssl rand -hex 24; done
# 48 random bytes, base64url (64 characters): the API's keys. The MFA key is exactly 32 bytes, as 64 hex characters.
b64url48() { openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'; echo; }
for name in jwt_access_secret otp_pepper messaging_hash_key; do new_secret "$SECRETS_DIR/api/$name" b64url48; done
new_secret "$SECRETS_DIR/api/platform_mfa_key" openssl rand -hex 32

# The connection strings, rebuilt from the password files every time (they hold nothing the password files do not).
APP_PW=$(cat "$SECRETS_DIR/db/app.pw")
MIGRATOR_PW=$(cat "$SECRETS_DIR/db/migrator.pw")
printf 'mysql://phonestore_app:%s@db:3306/phonestore?connection_limit=10\n' "$APP_PW" > "$SECRETS_DIR/api/app_database_url"
printf 'DATABASE_URL=mysql://phonestore_app:%s@db:3306/phonestore\n' "$APP_PW" > "$SECRETS_DIR/database.env"
printf 'DATABASE_URL=mysql://phonestore_migrator:%s@db:3306/phonestore\n' "$MIGRATOR_PW" > "$SECRETS_DIR/migrator.env"
unset APP_PW MIGRATOR_PW
find "$SECRETS_DIR" -type f -exec chmod 600 {} +

echo "secrets: $made generated now; $(find "$SECRETS_DIR" -type f | wc -l) files under $SECRETS_DIR (mode 600)."
for f in "$SECRETS_DIR"/api/smtp_username "$SECRETS_DIR"/api/smtp_password; do
  [ -s "$f" ] && echo "  $(basename "$f"): present (the owner's)" || echo "  $(basename "$f"): absent (email stays disabled until the owner enters it)"
done
