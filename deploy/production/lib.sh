# Shared by the production scripts (docs/100). Sourced, never run. Loads deploy/production/stack.env, enforces the
# profile's rules, refuses to run beside any other stack, and gives `compose` with the profile's own project name.
# Prints no secret.
set -euo pipefail
PRODUCTION_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(dirname "$PRODUCTION_DIR")
STACK_ENV=${STACK_ENV:-$PRODUCTION_DIR/stack.env}
die() { echo "Refusing: $*" >&2; exit 2; }

[ -f "$STACK_ENV" ] || die "missing $STACK_ENV — copy deploy/production/stack.env.example and fill it in (docs/100 §3)."
set -a
# shellcheck disable=SC1090
. "$STACK_ENV"
set +a
: "${DEPLOY_PROFILE:?}" "${API_HOST:?}" "${ACME_EMAIL:?}" "${EDGE_HTTP_BIND:?}" "${EDGE_HTTPS_BIND:?}"
: "${SECRETS_DIR:?}" "${BACKUP_DIR:?}" "${API_ENV_FILE:?}"

# ── The profile's rules: a rehearsal can never be mistaken for production, nor production for a rehearsal ─────────────
case "$DEPLOY_PROFILE" in
  production)
    PROJECT=erp-production; BASE=/srv/erp-production; OTHERS="erp-staging erp-rehearsal"
    [ "$API_HOST" = api.tsxmr.com ] || die "the production API host is api.tsxmr.com (stack.env says $API_HOST)."
    [ "$EDGE_HTTP_BIND" = 80 ] && [ "$EDGE_HTTPS_BIND" = 443 ] || die "production publishes the edge on 80 and 443."
    ;;
  rehearsal)
    PROJECT=erp-rehearsal; BASE=/srv/erp-rehearsal; OTHERS="erp-staging erp-production"
    case "$API_HOST" in *.localhost) ;; *) die "a rehearsal's host is a *.localhost name, never a public one (stack.env says $API_HOST)." ;; esac
    case "$EDGE_HTTP_BIND $EDGE_HTTPS_BIND" in 127.0.0.1:*\ 127.0.0.1:*) ;; *) die "a rehearsal's edge listens on 127.0.0.1 only." ;; esac
    ;;
  *) die "DEPLOY_PROFILE must be production or rehearsal." ;;
esac
for path in "$SECRETS_DIR" "$BACKUP_DIR" "$API_ENV_FILE"; do
  case "$path" in "$BASE"/*) ;; *) die "$path is outside $BASE: each profile keeps to its own directory." ;; esac
done
export DEPLOY_PROFILE PROJECT

# ── Never beside another stack: staging, the rehearsal and production never coexist on this host ─────────────────────
# Containers, volumes and networks, running or not: a stopped project still holds a database.
other_stacks() {
  { docker ps -a --format '{{.Label "com.docker.compose.project"}}'
    docker volume ls --format '{{.Label "com.docker.compose.project"}}'
    docker network ls --format '{{.Label "com.docker.compose.project"}}'; } 2>/dev/null | sort -u | while read -r p; do
    for other in $OTHERS; do [ "$p" = "$other" ] && echo "$p"; done
  done
}
found=$(other_stacks | sort -u | tr '\n' ' ')
[ -z "${found// /}" ] || die "resources of ${found% } exist on this host. $PROJECT never runs beside them (docs/100 §9): remove them first."

# The images the stack runs now, written by deploy.sh and rollback.sh: every later command uses the deployed images,
# never a rebuild of whatever happens to be checked out.
CURRENT_IMAGES=$BACKUP_DIR/current-images.env
if [ -z "${API_IMAGE:-}" ] && [ -f "$CURRENT_IMAGES" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CURRENT_IMAGES"
  set +a
fi
record_images() { printf 'API_IMAGE=%s\nTOOLS_IMAGE=%s\n' "$API_IMAGE" "$TOOLS_IMAGE" > "$CURRENT_IMAGES"; }

compose() { docker compose -p "$PROJECT" --env-file "$STACK_ENV" -f "$DEPLOY_DIR/docker-compose.production.yml" "$@"; }

# `--confirm <API_HOST>` on every command that changes the stack: the operator types the host they mean to change.
require_confirm() {
  local given=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --confirm) given=${2:-}; if [ $# -ge 2 ]; then shift 2; else shift; fi ;;
      *) shift ;;
    esac
  done
  [ "$given" = "$API_HOST" ] || die "this changes $PROJECT. Add --confirm $API_HOST."
}

# One operator command at a time.
take_lock() {
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die "another deployment command holds $BACKUP_DIR/.lock."
}

# Wait until a service's container reports healthy (Docker HEALTHCHECK), or fail after N seconds.
wait_healthy() {
  local service=$1 limit=${2:-180} id status=missing
  for _ in $(seq 1 "$limit"); do
    id=$(compose ps -q "$service" 2>/dev/null || true)
    status=$( [ -n "$id" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)
    [ "$status" = healthy ] && return 0
    sleep 1
  done
  echo "$service is not healthy after ${limit}s (last status: $status)." >&2
  return 1
}

# Run SQL as root inside the database container: the root password is read there, from its own secret file.
db_root() { compose exec -T db sh -c 'MYSQL_PWD="$(cat /secrets/mysql_root.pw)" exec mysql -uroot -N -B "$@"' sh "$@"; }
