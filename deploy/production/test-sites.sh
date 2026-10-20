#!/usr/bin/env bash
# The private test sites of persistent test businesses on the production edge (D217; docs/100 §16).
#
#   deploy/production/test-sites.sh install app <release-dir> --confirm api.tsxmr.com
#   deploy/production/test-sites.sh install console <release-dir> --confirm api.tsxmr.com
#   deploy/production/test-sites.sh off app|console|all --confirm api.tsxmr.com
#   deploy/production/test-sites.sh rollback app|console <release-name> --confirm api.tsxmr.com
#
# app      erp-mobile's web export (scripts/web-test-release.mjs --production-api) at TEST_APP_HOST;
# console  erp-control-web's portal surface in preview mode (scripts/caddy-release.mjs) at TEST_CONSOLE_HOST.
#
# Refuses — before the edge is touched — a missing or production hostname, the API's own hostname, one name for both
# sites, a user or a hash that is not set (bcrypt: `docker run --rm -it caddy:2.11.7 caddy hash-password`), an API whose
# CORS_ORIGINS do not name the site exactly, an API whose customer activation is not closed, and a release that is
# incomplete or built for another API. The edge configuration is validated with the release before the edge restarts;
# restarting it interrupts the API for a few seconds. Ends by checking that every path answers 401 without the password
# and that the API grants the site's origin exactly. The releases stay on disk; `off` only disables a site.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
require_confirm "$@"
take_lock
: "${WEB_DIR:?set WEB_DIR in stack.env (e.g. /srv/erp-production/web)}"
: "${TOOLS_IMAGE:?no tools image recorded in current-images.env: deploy the API first}"

ACTION=${1:-} SITE=${2:-} ARG=${3:-}
LOG=$BACKUP_DIR/deployments.log

host_of() { case "$1" in app) echo "${TEST_APP_HOST:-}" ;; console) echo "${TEST_CONSOLE_HOST:-}" ;; esac; }

restart_edge() {
  compose up -d --no-deps --force-recreate edge
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Status}}' "$(compose ps -q edge)" 2>/dev/null)" = running ] && return 0
    sleep 1
  done
  echo "The edge did not start: compose logs edge." >&2
  return 1
}

# The edge's configuration as it will run, the enabled sites and their current releases included.
validate_edge() {
  compose run --rm --no-deps --entrypoint caddy edge validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null
}

check_names() {
  local site=$1 host
  host=$(host_of "$site")
  case "$host" in
    '') die "TEST_$( [ "$site" = app ] && echo APP || echo CONSOLE )_HOST is not set in stack.env." ;;
    tsxmr.com | www.tsxmr.com | dukan.tsxmr.com | api.tsxmr.com) die "$host is a production name: a test site has its own." ;;
  esac
  [ "$host" != "$API_HOST" ] || die "the site needs its own name, not the API's."
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "\"$host\" is not a hostname."
  [ -z "${TEST_APP_HOST:-}" ] || [ "${TEST_APP_HOST:-}" != "${TEST_CONSOLE_HOST:-}" ] || die "the app and the console need two names."
  [ -n "${TEST_WEB_USER:-}" ] || die "TEST_WEB_USER is not set."
  [[ "${TEST_WEB_PASSWORD_HASH:-}" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] \
    || die "TEST_WEB_PASSWORD_HASH is not a bcrypt hash (single-quote it in stack.env)."
  local cors activation
  cors=$(sed -n 's/^CORS_ORIGINS=//p' "$API_ENV_FILE" | tr -d "\"' ")
  [[ ",$cors," == *",https://$host,"* ]] \
    || die "the API's CORS_ORIGINS does not name https://$host — add it to $API_ENV_FILE and redeploy the API first."
  activation=$(sed -n 's/^CUSTOMER_ACTIVATION=//p' "$API_ENV_FILE" | tr -d "\"' ")
  [ -z "$activation" ] || [ "$activation" = closed ] || die "CUSTOMER_ACTIVATION is \"$activation\": the test sites run only while customer activation is closed (D217)."
}

check_release() {
  local site=$1 dir=$2
  case "$site" in
    app)
      [ -f "$dir/site/index.html" ] && [ -f "$dir/site/+not-found.html" ] && [ -f "$dir/routes.caddy" ] \
        || die "$dir is not an app release (site/index.html, site/+not-found.html, routes.caddy)."
      grep -rqsF "\"https://$API_HOST\"" "$dir/site/_expo/static/js" \
        || die "$dir was not built for https://$API_HOST (EXPO_PUBLIC_API_ORIGIN)."
      ;;
    console)
      [ -f "$dir/site/app-shell.html" ] && [ -f "$dir/site/404.html" ] && [ -f "$dir/routes.caddy" ] \
        || die "$dir is not a console release (site/app-shell.html, site/404.html, routes.caddy)."
      grep -qF "connect-src 'self' https://$API_HOST" "$dir/routes.caddy" \
        || die "$dir was not built for https://$API_HOST (VITE_API_BASE): its Content Security Policy does not name it."
      ;;
  esac
}

# A request to one of the edge's names: in production the public name; in a rehearsal the local edge on its own port,
# whose certificate is Caddy's local authority (as smoke.sh treats it).
edge_curl() {
  local host=$1 path=$2; shift 2
  if [ "$DEPLOY_PROFILE" = rehearsal ]; then
    local port=${EDGE_HTTPS_BIND##*:}
    curl -s -k --max-time 20 --resolve "$host:$port:127.0.0.1" "$@" "https://$host:$port$path"
  else
    curl -s --max-time 20 "$@" "https://$host$path"
  fi
}

# Locked: no credential, no page — the scripts and styles included. Then the API grants this origin exactly.
check_live() {
  local site=$1 host path code allowed
  host=$(host_of "$site")
  for path in / /login /setup /admin /subscription /assets/ /_expo/static/; do
    code=$(edge_curl "$host" "$path" -o /dev/null -w '%{http_code}' || true)
    [ "$code" = 401 ] || die "https://$host$path answered $code without a password (expected 401)."
  done
  # The browser's own preflight for a sign-in, as the smoke test sends it.
  allowed=$(edge_curl "$API_HOST" /api/v1/auth/login -o /dev/null -D - -X OPTIONS -H "Origin: https://$host" \
    -H 'Access-Control-Request-Method: POST' | tr -d '\r' | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: //p')
  [ "$allowed" = "https://$host" ] || die "the API grants \"${allowed:-nothing}\" to https://$host (expected exactly that origin)."
}

case "$ACTION" in
  install)
    case "$SITE" in app | console) ;; *) die "usage: test-sites.sh install app|console <release-dir> --confirm $API_HOST" ;; esac
    RELEASE=$ARG
    [ -n "$RELEASE" ] && [ -d "$RELEASE" ] || die "usage: test-sites.sh install $SITE <release-dir> --confirm $API_HOST"
    check_names "$SITE"
    check_release "$SITE" "$RELEASE"

    name=$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -p "$WEB_DIR/$SITE/releases" "$WEB_DIR/enabled"
    cp -R "$RELEASE" "$WEB_DIR/$SITE/releases/$name"
    previous=$(readlink "$WEB_DIR/$SITE/current" 2>/dev/null || true)
    was_enabled=0; [ -f "$WEB_DIR/enabled/test-$SITE.caddy" ] && was_enabled=1
    ln -sfn "releases/$name" "$WEB_DIR/$SITE/current"
    cp "$PRODUCTION_DIR/test-$SITE.caddy" "$WEB_DIR/enabled/test-$SITE.caddy"
    if ! validate_edge; then
      # Put back what served before, so a bad release never reaches the running edge.
      if [ -n "$previous" ]; then ln -sfn "$previous" "$WEB_DIR/$SITE/current"; else rm -f "$WEB_DIR/$SITE/current"; fi
      [ "$was_enabled" = 1 ] || rm -f "$WEB_DIR/enabled/test-$SITE.caddy"
      die "the edge configuration does not validate with this release. Nothing was changed."
    fi
    restart_edge
    printf '%s %s test-site %s install release=%s previous=%s host=%s\n' "$(date -u +%FT%TZ)" "$PROJECT" "$SITE" "$name" \
      "${previous:-none}" "$(host_of "$SITE")" >> "$LOG"
    check_live "$SITE"
    echo "Installed $SITE release $name at https://$(host_of "$SITE"): 401 without the password on every path checked;"
    echo "the API grants its origin exactly. Previous: ${previous:-none}."
    ;;
  rollback)
    case "$SITE" in app | console) ;; *) die "usage: test-sites.sh rollback app|console <release-name> --confirm $API_HOST" ;; esac
    [ -n "$ARG" ] && [ -d "$WEB_DIR/$SITE/releases/$ARG" ] || die "no release $ARG in $WEB_DIR/$SITE/releases."
    check_names "$SITE"
    previous=$(readlink "$WEB_DIR/$SITE/current" 2>/dev/null || true)
    ln -sfn "releases/$ARG" "$WEB_DIR/$SITE/current"
    if ! validate_edge; then
      if [ -n "$previous" ]; then ln -sfn "$previous" "$WEB_DIR/$SITE/current"; fi
      die "the edge configuration does not validate with $ARG. Nothing was changed."
    fi
    restart_edge
    printf '%s %s test-site %s rollback release=%s previous=%s\n' "$(date -u +%FT%TZ)" "$PROJECT" "$SITE" "$ARG" "${previous:-none}" >> "$LOG"
    check_live "$SITE"
    echo "The $SITE site serves release $ARG again (was ${previous:-none})."
    ;;
  off)
    case "$SITE" in app | console) sites=$SITE ;; all) sites="app console" ;; *) die "usage: test-sites.sh off app|console|all --confirm $API_HOST" ;; esac
    for s in $sites; do rm -f "$WEB_DIR/enabled/test-$s.caddy"; done
    validate_edge || die "the edge configuration does not validate without the site: compose logs edge."
    restart_edge
    printf '%s %s test-site off %s\n' "$(date -u +%FT%TZ)" "$PROJECT" "$sites" >> "$LOG"
    echo "Off: $sites. The releases stay in $WEB_DIR; the API and its data are untouched."
    ;;
  *)
    die "usage: test-sites.sh install app|console <release-dir> | rollback app|console <release> | off app|console|all, with --confirm $API_HOST"
    ;;
esac
