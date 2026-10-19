#!/usr/bin/env bash
# The browser-test site on the staging edge (docs/99 §14).
#
#   deploy/staging/web-test.sh install <release-dir>   copy a release in, enable the site, restart the edge, check it
#   deploy/staging/web-test.sh off                      disable the site (releases stay on disk), restart the edge
#
# <release-dir> is what erp-mobile `node scripts/web-test-release.mjs` wrote: `site/` and `routes.caddy`.
# Refuses — before the edge is touched — a missing or production hostname, the API's own hostname, a user or a hash
# that is not set (the hash must be bcrypt: `docker run --rm caddy:2.8 caddy hash-password`), an API whose CORS origins
# do not name the site exactly, and a release that is incomplete. Restarting the edge interrupts the API for seconds.
source "$(dirname "$0")/lib.sh"
: "${STAGING_WEB_DIR:?set STAGING_WEB_DIR in stack.env (e.g. /srv/erp-staging/web)}"

restart_edge() {
  compose up -d --no-deps --force-recreate edge
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Status}}' "$(compose ps -q edge)" 2>/dev/null)" = running ] && return 0
    sleep 1
  done
  echo "The edge did not start: compose logs edge." >&2
  return 1
}

case "${1:-}" in
  install)
    RELEASE=${2:?usage: web-test.sh install <release-dir>}
    host=${STAGING_WEB_HOST:-}
    case "$host" in
      '') echo "Refusing: STAGING_WEB_HOST is not set." >&2; exit 2 ;;
      tsxmr.com | www.tsxmr.com | dukan.tsxmr.com | api.tsxmr.com)
        echo "Refusing: $host is a production name." >&2; exit 2 ;;
    esac
    [ "$host" != "$STAGING_API_HOST" ] || { echo "Refusing: the site needs its own name, not the API's." >&2; exit 2; }
    [[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "Refusing: \"$host\" is not a hostname." >&2; exit 2; }
    [ -n "${STAGING_WEB_USER:-}" ] || { echo "Refusing: STAGING_WEB_USER is not set." >&2; exit 2; }
    [[ "${STAGING_WEB_PASSWORD_HASH:-}" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || {
      echo "Refusing: STAGING_WEB_PASSWORD_HASH is not a bcrypt hash (single-quote it in stack.env)." >&2; exit 2; }
    cors=$(sed -n 's/^CORS_ORIGINS=//p' "$STAGING_API_ENV_FILE" | tr -d "\"' ")
    [[ ",$cors," == *",https://$host,"* ]] || {
      echo "Refusing: the API's CORS_ORIGINS does not name https://$host — add it to $STAGING_API_ENV_FILE and redeploy the API first." >&2; exit 2; }
    [ -f "$RELEASE/site/index.html" ] && [ -f "$RELEASE/site/+not-found.html" ] && [ -f "$RELEASE/routes.caddy" ] || {
      echo "Refusing: $RELEASE is not a release (site/index.html, site/+not-found.html, routes.caddy)." >&2; exit 2; }

    name=$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -p "$STAGING_WEB_DIR/releases" "$STAGING_WEB_DIR/enabled"
    cp -R "$RELEASE" "$STAGING_WEB_DIR/releases/$name"
    previous=$(readlink "$STAGING_WEB_DIR/current" 2>/dev/null || true)
    ln -sfn "releases/$name" "$STAGING_WEB_DIR/current"
    cp "$STAGING_DIR/web-test.caddy" "$STAGING_WEB_DIR/enabled/web-test.caddy"
    if ! compose run --rm --no-deps --entrypoint caddy edge validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null; then
      # Put back what served before, so a bad release never reaches the running edge.
      if [ -n "$previous" ]; then ln -sfn "$previous" "$STAGING_WEB_DIR/current"; else rm -f "$STAGING_WEB_DIR/enabled/web-test.caddy"; fi
      echo "Refusing: the edge configuration does not validate with this release. Nothing was changed." >&2
      exit 1
    fi
    restart_edge
    printf '%s web-test install release=%s previous=%s host=%s\n' "$(date -u +%FT%TZ)" "$name" "${previous:-none}" "$host" >> "$STAGING_BACKUP_DIR/deployments.log"

    # Locked: no credential, no page — the app's scripts included.
    for path in / /login /_expo/static/; do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$host$path" || true)
      [ "$code" = 401 ] || { echo "FAIL https://$host$path answered $code without a password (expected 401)." >&2; exit 1; }
    done
    echo "Installed $name at https://$host (401 without a password on every path checked). Previous: ${previous:-none}."
    echo "Rollback: ln -sfn ${previous:-<release>} $STAGING_WEB_DIR/current && deploy/staging/web-test.sh restart-edge"
    ;;
  off)
    rm -f "$STAGING_WEB_DIR/enabled/web-test.caddy"
    restart_edge
    printf '%s web-test off\n' "$(date -u +%FT%TZ)" >> "$STAGING_BACKUP_DIR/deployments.log"
    echo "The browser-test site is off. Releases stay in $STAGING_WEB_DIR/releases."
    ;;
  restart-edge)
    restart_edge
    ;;
  *)
    echo "usage: web-test.sh install <release-dir> | off | restart-edge" >&2
    exit 2
    ;;
esac
