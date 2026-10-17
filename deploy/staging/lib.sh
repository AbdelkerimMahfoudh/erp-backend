# Shared by the staging scripts (docs/99). Sourced, never run. Loads deploy/staging/stack.env, gives `compose` with
# the staging project, and waits on container health. Prints no secret.
set -euo pipefail
STAGING_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(dirname "$STAGING_DIR")
STACK_ENV=${STACK_ENV:-$STAGING_DIR/stack.env}
if [ ! -f "$STACK_ENV" ]; then
  echo "Missing $STACK_ENV — copy deploy/staging/stack.env.example and fill it in (docs/99 §3)." >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
. "$STACK_ENV"
set +a
: "${STAGING_SECRETS_DIR:?}" "${STAGING_BACKUP_DIR:?}" "${STAGING_API_ENV_FILE:?}" "${STAGING_API_HOST:?}"

# The images the stack runs now, written by deploy.sh and rollback.sh: every later command (a migration, a restart, a
# tools run, the smoke test) uses the deployed images, never a rebuild of whatever happens to be checked out.
CURRENT_IMAGES=$STAGING_BACKUP_DIR/current-images.env
if [ -z "${API_IMAGE:-}" ] && [ -f "$CURRENT_IMAGES" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CURRENT_IMAGES"
  set +a
fi
record_images() { printf 'API_IMAGE=%s\nTOOLS_IMAGE=%s\n' "$API_IMAGE" "$TOOLS_IMAGE" > "$CURRENT_IMAGES"; }

compose() { docker compose --env-file "$STACK_ENV" -f "$DEPLOY_DIR/docker-compose.staging.yml" "$@"; }

# Wait until a service's container reports healthy (Docker HEALTHCHECK), or fail after N seconds.
wait_healthy() {
  local service=$1 limit=${2:-180} id status
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
