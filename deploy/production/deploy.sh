#!/usr/bin/env bash
# One deployment of the checked-out, committed tree (docs/100 §6). Production and the rehearsal alike: the profile in
# stack.env decides which, and lib.sh refuses anything that would mix them.
#
#   deploy/production/deploy.sh --confirm api.tsxmr.com [--after-interrupted]
#
#   1. refuses an uncommitted tree: what runs must be a commit anyone can check out;
#   2. builds the runtime and tools images, tagged with the commit (they stay on the host: the rollback targets);
#   3. the generated secrets (setup-secrets.sh: only what is missing) and the stack contract (check-stack.mjs);
#   4. first time only: the database server, schema and identities (setup-database.sh);
#   5. migrate.sh: preflight → backup → migrate as the migrator → catalogue → identities → audit chain;
#   6. replaces the API container, waits for readiness (every carried migration applied), starts the edge;
#   7. records the deployment and runs the smoke test.
#
# Interrupted or failed, it leaves deploy.inprogress (the commit and the step) and a line in deployments.log; the next
# run stops on that marker until the operator has read it and says so with --after-interrupted. Everything it repeats
# is idempotent (secrets, identities, `migrate deploy`); a migration that failed half-way is docs/79 §C2.
# SKIP_BUILD=1 with API_IMAGE/TOOLS_IMAGE set deploys images built elsewhere instead.
REQUESTED_API_IMAGE=${API_IMAGE:-} REQUESTED_TOOLS_IMAGE=${TOOLS_IMAGE:-}
source "$(dirname "$0")/lib.sh"
# The ERR trap below must see failures inside functions too (wait_healthy, step).
set -E
require_confirm "$@"
AFTER_INTERRUPTED=0
for a in "$@"; do [ "$a" = --after-interrupted ] && AFTER_INTERRUPTED=1; done
take_lock
REPO=$(cd "$DEPLOY_DIR/.." && pwd)
MARK=$BACKUP_DIR/deploy.inprogress
LOG=$BACKUP_DIR/deployments.log

if [ -f "$MARK" ]; then
  echo "An earlier deployment did not finish: $(cat "$MARK")"
  [ "$AFTER_INTERRUPTED" = 1 ] || die "read deployments.log and the line above, then re-run with --after-interrupted (docs/100 §6)."
fi
[ -z "$(git -C "$REPO" status --porcelain)" ] || die "the checkout has uncommitted changes. Deploy a commit."
[ -s "$API_ENV_FILE" ] || die "missing $API_ENV_FILE — copy .env.production.example there (mode 600) and fill it in."

COMMIT=$(git -C "$REPO" rev-parse HEAD)
export APP_COMMIT=$COMMIT
export APP_BUILT_AT=${APP_BUILT_AT:-$(date -u +%FT%TZ)}
if [ "${SKIP_BUILD:-0}" = 1 ]; then
  [ -n "$REQUESTED_API_IMAGE" ] && [ -n "$REQUESTED_TOOLS_IMAGE" ] || die "SKIP_BUILD=1 needs API_IMAGE and TOOLS_IMAGE."
  export API_IMAGE=$REQUESTED_API_IMAGE TOOLS_IMAGE=$REQUESTED_TOOLS_IMAGE
else
  export API_IMAGE=erp-api:$COMMIT TOOLS_IMAGE=erp-api-tools:$COMMIT
fi
PREVIOUS=$(compose ps -q api 2>/dev/null | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null || true)

STEP=start
step() {
  STEP=$1
  printf '%s %s commit=%s step=%s\n' "$(date -u +%FT%TZ)" "$PROJECT" "$COMMIT" "$STEP" > "$MARK"
  echo "== $STEP"
}
trap 'printf "%s %s FAILED commit=%s step=%s\n" "$(date -u +%FT%TZ)" "$PROJECT" "$COMMIT" "$STEP" >> "$LOG"' ERR
trap 'printf "%s %s INTERRUPTED commit=%s step=%s\n" "$(date -u +%FT%TZ)" "$PROJECT" "$COMMIT" "$STEP" >> "$LOG"; exit 130' INT TERM

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  step build
  compose build api
  compose --profile tools build migrate
fi

step secrets
"$PRODUCTION_DIR/setup-secrets.sh"

step contract
compose --profile tools --profile proof config --format json \
  | docker run --rm -i --network none "$TOOLS_IMAGE" node deploy/production/check-stack.mjs --profile "$DEPLOY_PROFILE"

if [ ! -f "$SECRETS_DIR/.database-ready" ]; then
  step database
  "$PRODUCTION_DIR/setup-database.sh"
  touch "$SECRETS_DIR/.database-ready"
fi
compose up -d db
wait_healthy db 240

step migrate
IN_DEPLOY=1 "$PRODUCTION_DIR/migrate.sh" --confirm "$API_HOST"

step api
compose up -d --no-deps api
wait_healthy api 240
step edge
compose up -d --no-deps edge
record_images
printf '%s %s commit=%s image=%s previous=%s\n' "$(date -u +%FT%TZ)" "$PROJECT" "$COMMIT" "$API_IMAGE" "${PREVIOUS:-none}" >> "$LOG"

step smoke
"$PRODUCTION_DIR/smoke.sh" --commit "$COMMIT"
rm -f "$MARK"
trap - ERR INT TERM
echo "Deployed $COMMIT to $PROJECT. Rollback target: ${PREVIOUS:-none (first deployment)}."
