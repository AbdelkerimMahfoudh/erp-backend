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
# The D227 floors (docs/116 §6). Code built before 0118 reads a business's name as never null; code built before 0125
# cannot read a code or intent whose purpose is `credential_change`. Such code is a rollback target only while no row
# needs what it cannot read; afterwards the way back is a fix rolled forward, or the restore of docs/116 §6.
if ! docker run --rm --entrypoint sh "$target" -c 'test -d /app/prisma/migrations/0118_company_name_optional'; then
  unnamed=$(db_root -e "SELECT (SELECT COUNT(*) FROM phonestore.companies WHERE name IS NULL)
    + (SELECT COUNT(*) FROM phonestore.registration_attempts WHERE business_name IS NULL)" | tr -d '[:space:]')
  [ "$unnamed" = 0 ] || die "$target predates 0118 and cannot read a business without a name; the database holds $unnamed such row(s). Roll a fix forward instead (docs/116 §6)."
  echo "0118 floor: no business without a name: rollback allowed by this floor."
fi
if ! docker run --rm --entrypoint sh "$target" -c 'test -d /app/prisma/migrations/0125_credential_changes'; then
  changes=$(db_root -e "SELECT (SELECT COUNT(*) FROM phonestore.otp_challenges WHERE purpose = 'credential_change')
    + (SELECT COUNT(*) FROM phonestore.verification_intents WHERE purpose = 'credential_change')" | tr -d '[:space:]')
  [ "$changes" = 0 ] || die "$target predates 0125 and cannot read a sign-in change's code; the database holds $changes such row(s). Roll a fix forward instead (docs/116 §6)."
  echo "0125 floor: no sign-in change code: rollback allowed by this floor."
fi
# The post-Build-4 floor (0128). Code built before it does not know a business prepared for deletion or deleted: it would
# show one as merely cancelled and let a console act on it. A rollback target only while no deletion was ever started.
if ! docker run --rm --entrypoint sh "$target" -c 'test -d /app/prisma/migrations/0128_business_deletion'; then
  deletions=$(db_root -e "SELECT COUNT(*) FROM phonestore.business_deletions" | tr -d '[:space:]')
  [ "$deletions" = 0 ] || die "$target predates 0128 and does not know a business prepared for deletion or deleted; the database holds $deletions such row(s). Roll a fix forward instead."
  echo "0128 floor: no business deletion started: rollback allowed by this floor."
fi
# The 0130–0132 floors (docs/122 §10). Code built before 0130/0131 cannot read a notice kind it does not know
# (`branch_activation`, `trial_started`); code built before 0132 ignores each store's own entitlement, so once any store
# has a decision of its own (a payment, trial, grant or admin period, or a proof naming stores) it would grant or refuse
# by the business alone. Grandfathered rows only copy the business's timeline: they never block a rollback.
if ! docker run --rm --entrypoint sh "$target" -c 'test -d /app/prisma/migrations/0130_branch_requests'; then
  n=$(db_root -e "SELECT COUNT(*) FROM phonestore.subscription_notices WHERE kind = 'branch_activation'" | tr -d '[:space:]')
  [ "$n" = 0 ] || die "$target predates 0130 and cannot read a branch-activation notice; the database holds $n. Roll a fix forward instead."
  echo "0130 floor: no branch-activation notice: rollback allowed by this floor."
fi
if ! docker run --rm --entrypoint sh "$target" -c 'test -d /app/prisma/migrations/0131_automatic_trial'; then
  n=$(db_root -e "SELECT COUNT(*) FROM phonestore.subscription_notices WHERE kind = 'trial_started'" | tr -d '[:space:]')
  [ "$n" = 0 ] || die "$target predates 0131 and cannot read a trial-started notice; the database holds $n. Roll a fix forward instead."
  echo "0131 floor: no trial-started notice: rollback allowed by this floor."
fi
if ! docker run --rm --entrypoint sh "$target" -c 'test -d /app/prisma/migrations/0132_branch_entitlements'; then
  n=$(db_root -e "SELECT (SELECT COUNT(*) FROM phonestore.branch_periods WHERE source <> 'grandfathered')
    + (SELECT COUNT(*) FROM phonestore.payment_proofs WHERE \`lines\` IS NOT NULL)" | tr -d '[:space:]')
  [ "$n" = 0 ] || die "$target predates 0132 and would decide every store by the business alone; $n store decision(s) of their own exist. Roll a fix forward instead (docs/122 §10)."
  echo "0132 floor: no store decision of its own: rollback allowed by this floor."
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
