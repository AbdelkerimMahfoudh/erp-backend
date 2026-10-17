#!/usr/bin/env bash
# One staging deployment of the checked-out, committed tree (docs/99 §6).
#
#   deploy/staging/deploy.sh
#
#   1. refuses an uncommitted tree: what runs must be a commit anyone can check out;
#   2. builds the runtime and tools images, tagged with the commit (they stay on the host: the rollback targets);
#   3. first time only: setup-database.sh (passwords, identities, schema);
#   4. migrate.sh: preflight → backup → migrate as the migrator → catalogue → identities;
#   5. replaces the API container, waits for readiness (every carried migration applied), starts the edge;
#   6. records the deployment and runs the smoke test against the public HTTPS name.
# SKIP_BUILD=1 with API_IMAGE/TOOLS_IMAGE set deploys images built elsewhere (CI, or a registry) instead.
REQUESTED_API_IMAGE=${API_IMAGE:-} REQUESTED_TOOLS_IMAGE=${TOOLS_IMAGE:-}
source "$(dirname "$0")/lib.sh"
REPO=$(cd "$DEPLOY_DIR/.." && pwd)

if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  echo "Refusing: the checkout has uncommitted changes. Deploy a commit." >&2
  exit 2
fi
COMMIT=$(git -C "$REPO" rev-parse HEAD)
export APP_COMMIT=$COMMIT
export APP_BUILT_AT=${APP_BUILT_AT:-$(date -u +%FT%TZ)}
if [ "${SKIP_BUILD:-0}" = 1 ]; then
  [ -n "$REQUESTED_API_IMAGE" ] && [ -n "$REQUESTED_TOOLS_IMAGE" ] || { echo "SKIP_BUILD=1 needs API_IMAGE and TOOLS_IMAGE." >&2; exit 2; }
  export API_IMAGE=$REQUESTED_API_IMAGE TOOLS_IMAGE=$REQUESTED_TOOLS_IMAGE
else
  export API_IMAGE=erp-api:$COMMIT TOOLS_IMAGE=erp-api-tools:$COMMIT
fi
PREVIOUS=$(compose ps -q api 2>/dev/null | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null || true)

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  echo "== build $COMMIT"
  compose build api
  compose --profile tools build migrate
fi

[ -s "$STAGING_SECRETS_DIR/database.env" ] || "$STAGING_DIR/setup-database.sh"
compose up -d db
wait_healthy db 240

"$STAGING_DIR/migrate.sh"

echo "== start $API_IMAGE"
compose up -d --no-deps api
wait_healthy api 240
compose up -d --no-deps edge
record_images

printf '%s commit=%s image=%s previous=%s\n' "$(date -u +%FT%TZ)" "$COMMIT" "$API_IMAGE" "${PREVIOUS:-none}" >> "$STAGING_BACKUP_DIR/deployments.log"
echo "== smoke"
"$STAGING_DIR/smoke.sh" --commit "$COMMIT"
echo "Deployed $COMMIT. Rollback target: ${PREVIOUS:-none (first deployment)}."
