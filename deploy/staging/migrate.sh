#!/usr/bin/env bash
# The controlled migration step (docs/99 §6) — never part of `up`, never run by the API.
#
#   deploy/staging/migrate.sh
#
# In order, stopping at the first failure:
#   1. preflight (the API's environment against the staging policy);
#   2. a verified, encrypted backup — unless the schema is still empty (first deployment);
#   3. `prisma migrate deploy` then `migrate status`, as phonestore_migrator, from the tools image of THIS commit;
#   4. the permission catalogue and role grants against the code, as phonestore_app;
#   5. the four identities proved against the migrated schema (each refused what it must not do, triggers included).
# It does not start or restart the API: deploy.sh does that after this succeeds. On a failure here the running API
# keeps serving the schema it had (docs/99 §8 for the P3018 path).
source "$(dirname "$0")/lib.sh"

echo "== 1. preflight"
"$STAGING_DIR/preflight.sh"

tables=$(db_root -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'phonestore_staging'")
if [ "$tables" -gt 0 ]; then
  echo "== 2. backup before migrating ($tables tables)"
  "$STAGING_DIR/backup.sh"
else
  echo "== 2. empty schema: nothing to back up (first deployment)"
fi

echo "== 3. migrations, as the migrator"
compose --profile tools run --rm --no-deps migrate

echo "== 4. permission catalogue, as the app identity"
compose --profile tools run --rm --no-deps tools npx ts-node --transpile-only scripts/verify-permission-catalogue.ts

echo "== 5. identities against the migrated schema"
compose exec -T db bash -c 'APP_PW="$(cat /secrets/app.pw)" BACKUP_PW="$(cat /secrets/backup.pw)" MIGRATOR_PW="$(cat /secrets/migrator.pw)" \
  DB=phonestore_staging MYSQL_SOCKET=/var/run/mysqld/mysqld.sock bash /deploy/verify-mysql-identities.sh'
echo "Migrations applied and verified."
