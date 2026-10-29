#!/usr/bin/env bash
# Put the previous API image back (docs/100 §11 — code rollback only).
#
#   deploy/production/rollback.sh erp-api:<previous commit> --confirm api.tsxmr.com
#
# The database is NOT rolled back: the older code runs on the newer schema. That is safe when the newer migrations are
# additive — the project's rule — and NOT safe across the floors docs/79 §C1 names (never below 0092 once money-agent
# exchanges exist; never below 0097 while a seat allocation is "scheduled"), nor below 0107 once a buying cost is
# unknown anywhere (enforced below, docs/100 §18). Rolling the schema back is a restore into
# a NEW schema (restore-drill.sh with KEEP_DRILL=1, then point the API at it), never a drop: docs/100 §11.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
target=${1:-}
case "$target" in erp-api:*) ;; *) die "usage: deploy/production/rollback.sh erp-api:<commit> --confirm $API_HOST (deployments.log names the previous one)." ;; esac
require_confirm "$@"
take_lock
docker image inspect "$target" > /dev/null 2>&1 || die "no image $target on this host."
# The 0107 floor (an unknown buying cost, D223/D224). Code built before 0107 reads a buying cost as never null and
# refuses every row of unknown cost ("Error converting field cost … non-nullable"): the inventory list, those sales
# and their sale of stock. Proven on 0109 with representative data against f5da650 and 644f4f5 (docs/100 §18). Such
# code is a rollback target only while the database holds no row of unknown cost; afterwards the way back is a fix
# rolled forward, never this script.
if ! docker run --rm --entrypoint sh "$target" -c 'test -d /app/prisma/migrations/0107_unknown_cost'; then
  unknown=$(db_root -e "SELECT (SELECT COUNT(*) FROM phonestore.units WHERE cost IS NULL)
    + (SELECT COUNT(*) FROM phonestore.stock_items WHERE cost IS NULL OR missing_cost_quantity > 0)
    + (SELECT COUNT(*) FROM phonestore.purchase_items WHERE unit_cost IS NULL)
    + (SELECT COUNT(*) FROM phonestore.stock_receipts WHERE unit_cost IS NULL)
    + (SELECT COUNT(*) FROM phonestore.sale_items WHERE cost IS NULL)
    + (SELECT COUNT(*) FROM phonestore.return_reversals WHERE line_cost IS NULL)" | tr -d '[:space:]')
  [ "$unknown" = 0 ] || die "$target predates 0107 and cannot read a buying cost of unknown value; the database holds $unknown such row(s). Roll a fix forward instead (docs/100 §18)."
  echo "0107 floor: $target predates 0107, and the database holds no row of unknown cost: rollback allowed."
fi
export API_IMAGE=$target
# The tools image of the same commit when the host still has it (deploy.sh tags both alike), else the current one.
tools=${target/erp-api:/erp-api-tools:}
if docker image inspect "$tools" > /dev/null 2>&1; then export TOOLS_IMAGE=$tools; fi
: "${TOOLS_IMAGE:?no tools image recorded in current-images.env}"
compose up -d --no-deps api
wait_healthy api 240
record_images
commit=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$target" | sed -n 's/^APP_COMMIT=//p')
printf '%s %s ROLLBACK to %s (commit %s)\n' "$(date -u +%FT%TZ)" "$PROJECT" "$target" "$commit" >> "$BACKUP_DIR/deployments.log"
"$PRODUCTION_DIR/smoke.sh" --commit "$commit"
