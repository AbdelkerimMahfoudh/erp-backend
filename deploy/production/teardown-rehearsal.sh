#!/usr/bin/env bash
# Remove the disposable rehearsal completely (docs/100 §9.3), and prove nothing of it remains.
#
#   deploy/production/teardown-rehearsal.sh --confirm <the rehearsal's API_HOST>
#
# Refuses outside the rehearsal profile. Removes the erp-rehearsal containers, volumes (its database and identities go
# with them), networks and images, the build cache, and the whole rehearsal directory — its checkout, secrets, proof
# material and backups. Production's directory and anything outside /srv/erp-rehearsal are never touched.
# Note: deleting a file on an SSD or a copy-on-write filesystem is not a guaranteed erasure of its blocks; what is
# guaranteed is that nothing reachable on the host still holds it (docs/100 §9.3).
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
[ "$DEPLOY_PROFILE" = rehearsal ] && [ "$PROJECT" = erp-rehearsal ] && [ "$BASE" = /srv/erp-rehearsal ] \
  || die "teardown-rehearsal.sh removes the rehearsal only."
require_confirm "$@"

echo "== containers, volumes, networks and images of $PROJECT"
compose --profile tools --profile proof down --volumes --remove-orphans --rmi all 2>&1 | tail -n 3 || true
for ref in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^erp-api(-tools)?:' || true); do docker rmi "$ref" > /dev/null; done
docker builder prune -af > /dev/null
docker image prune -f > /dev/null

echo "== the rehearsal directory"
cd / || exit 1
rm -rf /srv/erp-rehearsal

echo "== what remains"
left=0
n=$(docker ps -aq --filter label=com.docker.compose.project=erp-rehearsal | wc -l); echo "  containers of erp-rehearsal: $n"; left=$((left + n))
for kind in volume network; do
  n=$(docker "$kind" ls -q --filter label=com.docker.compose.project=erp-rehearsal | wc -l)
  echo "  ${kind}s of erp-rehearsal: $n"; left=$((left + n))
done
n=$(docker images -q | wc -l); echo "  images on the host: $n"
[ -e /srv/erp-rehearsal ] && { echo "  /srv/erp-rehearsal still exists"; left=$((left + 1)); } || echo "  /srv/erp-rehearsal: gone"
n=$(find /dev/shm -maxdepth 1 -name 'erp-*' 2>/dev/null | wc -l); echo "  rehearsal files in /dev/shm: $n"; left=$((left + n))
[ "$left" -eq 0 ] && echo "teardown: CLEAN" || { echo "teardown: $left item(s) remain"; exit 1; }
