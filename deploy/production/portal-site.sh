#!/usr/bin/env bash
# The customers' portal on the production edge (https://dukan.tsxmr.com; post-Build-4).
#
#   deploy/production/portal-site.sh install <release-dir> --confirm api.tsxmr.com
#   deploy/production/portal-site.sh rollback <release-name> --confirm api.tsxmr.com
#   deploy/production/portal-site.sh off --confirm api.tsxmr.com
#
# Refuses, before the edge is touched: any hostname but PORTAL_HOST=dukan.tsxmr.com, an API whose CORS_ORIGINS does not
# name it or whose ADMIN_ORIGINS does, a PORTAL_ORIGIN other than it, and a release that is incomplete, built for another
# API, or holds the console. The edge configuration is validated with the release before the edge restarts; restarting
# it interrupts the API for a few seconds. Ends by checking the live site and the API's boundary. The releases stay on
# disk; `off` only disables the site. PORTAL_LIVE=enabled is the operator's step after these checks, never this script's.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
require_confirm "$@"
take_lock
: "${WEB_DIR:?set WEB_DIR in stack.env (e.g. /srv/erp-production/web)}"

ACTION=${1:-} ARG=${2:-}
LOG=$BACKUP_DIR/deployments.log
HOST=${PORTAL_HOST:-}
ORIGIN=https://$HOST
ENABLED=$WEB_DIR/enabled/customer-portal.caddy

restart_edge() {
  compose up -d --no-deps --force-recreate edge
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Status}}' "$(compose ps -q edge)" 2>/dev/null)" = running ] && return 0
    sleep 1
  done
  echo "The edge did not start: compose logs edge." >&2
  return 1
}

validate_edge() {
  compose run --rm --no-deps --entrypoint caddy edge validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null
}

check_names() {
  [ "$HOST" = dukan.tsxmr.com ] || die "PORTAL_HOST must be dukan.tsxmr.com (it is \"$HOST\")."
  local cors admin portal
  cors=$(sed -n 's/^CORS_ORIGINS=//p' "$API_ENV_FILE" | tr -d "\"' ")
  admin=$(sed -n 's/^ADMIN_ORIGINS=//p' "$API_ENV_FILE" | tr -d "\"' ")
  portal=$(sed -n 's/^PORTAL_ORIGIN=//p' "$API_ENV_FILE" | tr -d "\"' ")
  [[ ",$cors," == *",$ORIGIN,"* ]] || die "the API's CORS_ORIGINS does not name $ORIGIN: add it to $API_ENV_FILE and redeploy the API first."
  [[ ",$admin," != *",$ORIGIN,"* ]] || die "ADMIN_ORIGINS names the customers' portal."
  [ "$portal" = "$ORIGIN" ] || die "the API's PORTAL_ORIGIN is \"$portal\", not $ORIGIN."
}

check_release() {
  local dir=$1
  [ -f "$dir/site/app-shell.html" ] && [ -f "$dir/site/404.html" ] && [ -f "$dir/routes.caddy" ]     || die "$dir is not a portal release (site/app-shell.html, site/404.html, routes.caddy)."
  [ -f "$dir/portal-release.txt" ] || die "$dir was not written by scripts/caddy-portal-release.mjs."
  grep -qF "connect-src 'self' https://$API_HOST" "$dir/routes.caddy" || die "$dir was not built for https://$API_HOST."
  ! grep -qF '/admin' "$dir/routes.caddy" || die "$dir serves the console."
  ! grep -rqE 'platform/admin/|platform/businesses' "$dir/site" || die "$dir holds console code."
  [ -z "$(find "$dir/site" -name '*.map' -print -quit)" ] || die "$dir publishes source maps."
}

edge_curl() {
  local host=$1 path=$2; shift 2
  curl -s --max-time 20 "$@" "https://$host$path"
}

# The portal answers, the console does not, and the API's boundary holds.
check_live() {
  local code allowed
  code=$(edge_curl "$HOST" /subscription -o /dev/null -w '%{http_code}' || true)
  [ "$code" = 200 ] || die "$ORIGIN/subscription answered $code (expected 200)."
  edge_curl "$HOST" /subscription -o /dev/null -D - | tr -d '' | grep -qi '^x-robots-tag: .*noindex' || die "$ORIGIN/subscription does not say noindex."
  code=$(edge_curl "$HOST" /claim/check -o /dev/null -w '%{http_code}' || true)
  [ "$code" = 200 ] || die "$ORIGIN/claim/ answered $code (expected the page, 200)."
  code=$(edge_curl "$HOST" /admin -o /dev/null -w '%{http_code}' || true)
  [ "$code" = 404 ] || die "$ORIGIN/admin answered $code (expected 404)."
  allowed=$(edge_curl "$API_HOST" /api/v1/platform/portal/session -o /dev/null -D - -X OPTIONS -H "Origin: $ORIGIN"     -H 'Access-Control-Request-Method: GET' | tr -d '' | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: //p')
  [ "$allowed" = "$ORIGIN" ] || die "the API grants \"${allowed:-nothing}\" to $ORIGIN."
  code=$(edge_curl "$API_HOST" /api/v1/platform/admin/me -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN")
  [ "$code" = 403 ] || die "the API answered $code to the portal on an administrator route (expected 403)."
}

case "$ACTION" in
  install)
    [ -n "$ARG" ] && [ -d "$ARG" ] || die "usage: portal-site.sh install <release-dir> --confirm $API_HOST"
    check_names
    check_release "$ARG"
    name=$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -p "$WEB_DIR/portal/releases" "$WEB_DIR/enabled"
    cp -R "$ARG" "$WEB_DIR/portal/releases/$name"
    previous=$(readlink "$WEB_DIR/portal/current" 2>/dev/null || true)
    was_enabled=0; [ -f "$ENABLED" ] && was_enabled=1
    ln -sfn "releases/$name" "$WEB_DIR/portal/current"
    cp "$PRODUCTION_DIR/customer-portal.caddy" "$ENABLED"
    if ! validate_edge; then
      if [ -n "$previous" ]; then ln -sfn "$previous" "$WEB_DIR/portal/current"; else rm -f "$WEB_DIR/portal/current"; fi
      [ "$was_enabled" = 1 ] || rm -f "$ENABLED"
      die "the edge configuration does not validate with this release. Nothing was changed."
    fi
    restart_edge
    printf '%s %s portal-site install release=%s previous=%s host=%s\n' "$(date -u +%FT%TZ)" "$PROJECT" "$name" "${previous:-none}" "$HOST" >> "$LOG"
    check_live
    echo "Installed portal release $name at $ORIGIN. Previous: ${previous:-none}. PORTAL_LIVE stays as it is: set it after checking sign-in and a claim link."
    ;;
  rollback)
    [ -n "$ARG" ] && [ -d "$WEB_DIR/portal/releases/$ARG" ] || die "no release $ARG in $WEB_DIR/portal/releases."
    check_names
    previous=$(readlink "$WEB_DIR/portal/current" 2>/dev/null || true)
    ln -sfn "releases/$ARG" "$WEB_DIR/portal/current"
    if ! validate_edge; then
      if [ -n "$previous" ]; then ln -sfn "$previous" "$WEB_DIR/portal/current"; fi
      die "the edge configuration does not validate with $ARG. Nothing was changed."
    fi
    restart_edge
    printf '%s %s portal-site rollback release=%s previous=%s\n' "$(date -u +%FT%TZ)" "$PROJECT" "$ARG" "${previous:-none}" >> "$LOG"
    check_live
    echo "The portal serves release $ARG again (was ${previous:-none})."
    ;;
  off)
    rm -f "$ENABLED"
    validate_edge || die "the edge configuration does not validate without the site: compose logs edge."
    restart_edge
    printf '%s %s portal-site off\n' "$(date -u +%FT%TZ)" "$PROJECT" >> "$LOG"
    echo "Off. The releases stay in $WEB_DIR/portal; the API and its data are untouched."
    ;;
  *)
    die "usage: portal-site.sh install <release-dir> | rollback <release> | off, with --confirm $API_HOST"
    ;;
esac
