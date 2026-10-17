#!/usr/bin/env bash
# Put the previous API image back (docs/99 §8 — code rollback only).
#
#   deploy/staging/rollback.sh erp-api:<previous commit>
#
# The database is NOT rolled back: the older code runs on the newer schema. That is safe when the newer migrations are
# additive — the project's rule — and NOT safe across the floors docs/79 §C1 names (never below 0092 once money-agent
# exchanges exist; never below 0097 while a seat allocation is "scheduled"). Rolling the schema back is a restore into a
# NEW schema (restore-drill.sh with KEEP_DRILL=1, then point the API at it), never a drop: docs/99 §8.
source "$(dirname "$0")/lib.sh"
target=${1:?Usage: deploy/staging/rollback.sh <image, e.g. erp-api:<commit>> — see deployments.log for the previous one}
docker image inspect "$target" > /dev/null || { echo "No image $target on this host." >&2; exit 2; }
export API_IMAGE=$target
# The tools image of the same commit when the host still has it (deploy.sh tags both alike), else the current one.
tools=${target/erp-api:/erp-api-tools:}
if [ "$tools" != "$target" ] && docker image inspect "$tools" > /dev/null 2>&1; then export TOOLS_IMAGE=$tools; fi
compose up -d --no-deps api
wait_healthy api 240
record_images
commit=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$target" | sed -n 's/^APP_COMMIT=//p')
printf '%s ROLLBACK to %s (commit %s)\n' "$(date -u +%FT%TZ)" "$target" "$commit" >> "$STAGING_BACKUP_DIR/deployments.log"
"$STAGING_DIR/smoke.sh" --commit "$commit"
