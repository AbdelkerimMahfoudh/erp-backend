#!/usr/bin/env bash
# The database gates CI runs on every push (docs/48 controls 2 and 20; docs/22).
#
#   CI_DATABASE_GATES=disposable ROOT_PW=… MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 deploy/ci-database-gates.sh
#   CI_DATABASE_GATES=disposable MYSQL_SOCKET=/path/mysqld.sock deploy/ci-database-gates.sh
#
# On a FRESH, DISPOSABLE MySQL 8 server only — the runner's own, or a scratch server on a developer's machine. It
# refuses to start unless CI_DATABASE_GATES=disposable and the server has no `phonestore` or `addon_ci` schema, so it
# can never run against a database that holds anything.
#
# What it proves, in the order production does it:
#   1. the four identities are created from deploy/mysql-identities.sql, with passwords made here and never printed;
#   2. every migration applies from empty under MySQL 8's default strict sql_mode, as the migrator, and
#      `prisma migrate status` then reports nothing pending;
#   3. the permission catalogue and the role grants match the code (the deploy-time gate);
#   4. each identity is refused what it must not do, the audit triggers included (deploy/verify-mysql-identities.sh);
#   5. the env-gated real-MySQL spec (InnoDB locks, NOWAIT, CHECKs, concurrency) runs on its own `addon_ci` schema;
#   6. the 0099 real-MySQL spec (grace decisions, the notice outbox, the portal claim) runs on its own `grace_ci` schema;
#   7. the 0100 real-MySQL spec (the consent history) runs on that same disposable schema;
#   8. the 0101 real-MySQL spec (employee invitations: locks, the one-live UNIQUE, triggers, CHECKs) runs there too;
#   9. the 0102 real-MySQL spec (test businesses, the console's stores and invitations: locks and filters) runs there too;
#  10. the 0103 real-MySQL spec (promoter codes, attribution, user invitations: locks, uniqueness, triggers, CHECKs) too.
# Any failure exits non-zero.
set -euo pipefail

if [ "${CI_DATABASE_GATES:-}" != "disposable" ]; then
  echo "Refusing: set CI_DATABASE_GATES=disposable to confirm this server is disposable." >&2
  exit 2
fi

HOST=${MYSQL_HOST:-127.0.0.1}
PORT=${MYSQL_PORT:-3306}
if [ -n "${MYSQL_SOCKET:-}" ]; then CONN=(--socket "$MYSQL_SOCKET"); else CONN=(-h "$HOST" -P "$PORT" --protocol=TCP); fi
root() { MYSQL_PWD="${ROOT_PW:-}" mysql "${CONN[@]}" -u root -N -B "$@"; }

existing=$(root -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name IN ('phonestore', 'addon_ci', 'grace_ci')")
if [ "$existing" != "0" ]; then
  echo "Refusing: this server already has a phonestore, addon_ci or grace_ci schema." >&2
  exit 2
fi

# Prisma talks TCP. With a socket, the URL still needs a host: the socket goes in its query string.
if [ -n "${MYSQL_SOCKET:-}" ]; then URL_HOST="localhost"; URL_TAIL="?socket=$MYSQL_SOCKET"; else URL_HOST="$HOST:$PORT"; URL_TAIL=""; fi
url() { printf 'mysql://%s:%s@%s/%s%s' "$1" "$2" "$URL_HOST" "$3" "$URL_TAIL"; }

# MySQL 8's own default: the strict mode production runs (docs/22). Triggers need the binary-log setting (see
# deploy/mysql-identities.sql).
root -e "SET GLOBAL sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'; SET GLOBAL log_bin_trust_function_creators = 1"

echo "== 1. identities"
MIGRATOR_PW=$(openssl rand -hex 24)
APP_PW=$(openssl rand -hex 24)
BACKUP_PW=$(openssl rand -hex 24)
ADMIN_PW=$(openssl rand -hex 24)
root -e "CREATE DATABASE phonestore CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
{ printf "SET @migrator_pw='%s', @app_pw='%s', @backup_pw='%s', @admin_pw='%s';\n" \
    "$MIGRATOR_PW" "$APP_PW" "$BACKUP_PW" "$ADMIN_PW"
  cat deploy/mysql-identities.sql; } | root

echo "== 2. migrations from empty, as the migrator, strict sql_mode"
DATABASE_URL=$(url phonestore_migrator "$MIGRATOR_PW" phonestore) npx prisma migrate deploy
DATABASE_URL=$(url phonestore_migrator "$MIGRATOR_PW" phonestore) npx prisma migrate status

echo "== 3. permission catalogue and role grants"
DATABASE_URL=$(url phonestore_app "$APP_PW" phonestore) npx ts-node --transpile-only scripts/verify-permission-catalogue.ts

echo "== 4. what each identity cannot do"
# One fictitious business with a subscription and one event, so the append-only trigger probes have rows that
# exist: an UPDATE matching nothing fires no trigger (this schema is disposable).
root phonestore -e "SET @c = UNHEX(REPLACE(UUID(), '-', '')), @s = UNHEX(REPLACE(UUID(), '-', ''));
  INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (@c, 'CI identity probe', JSON_OBJECT(), NOW(6), 'CIPROBE0001');
  INSERT INTO subscriptions (id, company_id) VALUES (@s, @c);
  INSERT INTO subscription_events (id, company_id, subscription_id, kind, note) VALUES (UNHEX(REPLACE(UUID(), '-', '')), @c, @s, 'created', 'CI identity probe');
  SET @p = NOW(6) - INTERVAL 1 DAY;
  INSERT INTO grace_episodes (id, company_id, subscription_id, period_end, decision, started_at, ends_at, uses_before, window_start, recorded_at, recorded_by)
    VALUES (UNHEX(REPLACE(UUID(), '-', '')), @c, @s, @p, 'granted', @p, @p + INTERVAL 72 HOUR, 0, @p - INTERVAL 12 MONTH, @p + INTERVAL 1 SECOND, 'sweeper');
  INSERT INTO whatsapp_consents (id, number_hash, number_masked, event, version, locale, purposes, actor_company_id, source)
    VALUES (UNHEX(REPLACE(UUID(), '-', '')), REPEAT('0', 64), '+000***00', 'granted', 'ci-probe', 'en', 'operational_whatsapp', @c, 'mobile_registration');
  SET @u = UNHEX(REPLACE(UUID(), '-', ''));
  INSERT INTO users (id, company_id, name, login, personal_id, password_hash, invited_at, updated_at) VALUES (@u, @c, 'CI probe', 'ci-probe', 'CIPROBE001', 'x', NOW(6), NOW(6));
  INSERT INTO staff_invitations (id, company_id, user_id, token_hash, issued_by, expires_at)
    VALUES (UNHEX(REPLACE(UUID(), '-', '')), @c, @u, REPEAT('a', 64), 'ci-probe', NOW(6) + INTERVAL 72 HOUR);
  SET @p = UNHEX(REPLACE(UUID(), '-', '')), @pc = UNHEX(REPLACE(UUID(), '-', '')), @ra = UNHEX(REPLACE(UUID(), '-', ''));
  INSERT INTO promoters (id, public_ref, display_name, whatsapp_number, created_by, updated_by) VALUES (@p, RANDOM_BYTES(16), 'CI probe', '+22200000000', 'ci-probe', 'ci-probe');
  INSERT INTO promoter_codes (id, promoter_id, code, version, issued_by) VALUES (@pc, @p, '000001', 1, 'ci-probe');
  INSERT INTO registration_attempts (id, idempotency_key, company_id, business_name, owner_name) VALUES (@ra, 'ci-probe-attempt', @c, 'CI identity probe', 'CI probe');
  INSERT INTO business_acquisitions (id, company_id, registration_attempt_id, source, mechanism, promoter_id, promoter_code_id, code_version, promoter_name)
    VALUES (UNHEX(REPLACE(UUID(), '-', '')), @c, @ra, 'promoter', 'promo_code', @p, @pc, 1, 'CI probe')"
DB=phonestore APP_PW="$APP_PW" BACKUP_PW="$BACKUP_PW" MIGRATOR_PW="$MIGRATOR_PW" bash deploy/verify-mysql-identities.sh

echo "== 5. the real-MySQL spec, on its own schema"
root -e "CREATE DATABASE addon_ci CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; GRANT SELECT, INSERT, UPDATE, DELETE ON addon_ci.* TO 'phonestore_app'@'%'"
DATABASE_URL=$(url root "${ROOT_PW:-}" addon_ci) npx prisma migrate deploy
ADDON_ROOT_URL=$(url root "${ROOT_PW:-}" addon_ci) ADDON_APP_URL=$(url phonestore_app "$APP_PW" addon_ci) \
  npx jest --ci src/platform/trial-addons.mysql.spec.ts

echo "== 6. the 0099 real-MySQL spec (grace, the notice outbox, the portal claim), on its own schema"
root -e "CREATE DATABASE grace_ci CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; GRANT SELECT, INSERT, UPDATE, DELETE ON grace_ci.* TO 'phonestore_app'@'%'"
DATABASE_URL=$(url root "${ROOT_PW:-}" grace_ci) npx prisma migrate deploy
GRACE_ROOT_URL=$(url root "${ROOT_PW:-}" grace_ci) GRACE_APP_URL=$(url phonestore_app "$APP_PW" grace_ci) \
  npx jest --ci src/notices/lifecycle.mysql.spec.ts

echo "== 7. the 0100 real-MySQL spec (the consent history: locks, triggers, CHECKs), on the same disposable schema"
CONSENT_ROOT_URL=$(url root "${ROOT_PW:-}" grace_ci) CONSENT_APP_URL=$(url phonestore_app "$APP_PW" grace_ci) \
  npx jest --ci src/messaging/consent.mysql.spec.ts

echo "== 8. the 0101 real-MySQL spec (employee invitations: locks, one live per person, triggers, CHECKs), on the same disposable schema"
INVITATION_ROOT_URL=$(url root "${ROOT_PW:-}" grace_ci) INVITATION_APP_URL=$(url phonestore_app "$APP_PW" grace_ci) \
  npx jest --ci src/staff/staff-invitation.mysql.spec.ts

echo "== 9. the 0102 real-MySQL spec (test businesses, the console's stores and invitations), on the same disposable schema"
PROVISIONING_ROOT_URL=$(url root "${ROOT_PW:-}" grace_ci) PROVISIONING_APP_URL=$(url phonestore_app "$APP_PW" grace_ci) \
  npx jest --ci src/platform/provisioning.mysql.spec.ts

echo "== 9b. the 0109 real-MySQL spec (deferred WhatsApp verification, setup codes), on the same disposable schema"
PROVISIONING_ROOT_URL=$(url root "${ROOT_PW:-}" grace_ci) PROVISIONING_APP_URL=$(url phonestore_app "$APP_PW" grace_ci) \
  npx jest --ci src/platform/deferred-verification.mysql.spec.ts

echo "== 10. the 0103 real-MySQL spec (promoter codes, attribution, user invitations), on the same disposable schema"
ACQUISITION_ROOT_URL=$(url root "${ROOT_PW:-}" grace_ci) ACQUISITION_APP_URL=$(url phonestore_app "$APP_PW" grace_ci) \
  npx jest --ci src/acquisition/acquisition.mysql.spec.ts
