#!/usr/bin/env bash
# The controlled migration step (docs/100 §6) — never part of `up`, never run by the API.
#
#   deploy/production/migrate.sh --confirm api.tsxmr.com
#
# In order, stopping at the first failure:
#   1. preflight (the API's environment against the production policy);
#   2. an encrypted backup — unless the schema is still empty (first deployment);
#   3. `prisma migrate deploy` then `migrate status`, as phonestore_migrator, from the tools image of THIS commit;
#   4. the permission catalogue and role grants against the code, as phonestore_app;
#   5. the four identities proved against the migrated schema (each refused what it must not do, triggers included);
#   6. the audit hash chain of every company (nothing to walk on an empty schema).
# It does not start or restart the API: deploy.sh does that after this succeeds. On a failure here the running API
# keeps serving the schema it had; a half-applied migration (P3018) is docs/79 §C2, never "run it again and see".
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
require_confirm "$@"
[ -n "${IN_DEPLOY:-}" ] || take_lock

echo "== 1. preflight"
"$PRODUCTION_DIR/preflight.sh"

tables=$(db_root -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'phonestore'")
if [ "$tables" -gt 0 ]; then
  echo "== 2. backup before migrating ($tables tables)"
  IN_DEPLOY=1 "$PRODUCTION_DIR/backup.sh"
else
  echo "== 2. empty schema: nothing to back up (first deployment)"
fi

echo "== 3. migrations, as the migrator"
compose --profile tools run --rm --no-deps migrate

echo "== 4. permission catalogue, as the application identity"
compose --profile tools run --rm --no-deps tools npx ts-node --transpile-only scripts/verify-permission-catalogue.ts

echo "== 5. identities against the migrated schema"
compose exec -T db bash -c 'APP_PW="$(cat /secrets/app.pw)" BACKUP_PW="$(cat /secrets/backup.pw)" MIGRATOR_PW="$(cat /secrets/migrator.pw)" \
  DB=phonestore MYSQL_SOCKET=/var/run/mysqld/mysqld.sock bash /deploy/verify-mysql-identities.sh'

echo "== 6. audit hash chain"
compose --profile tools run --rm --no-deps tools npx ts-node --transpile-only scripts/verify-audit-chain.ts
echo "Migrations applied and verified."
