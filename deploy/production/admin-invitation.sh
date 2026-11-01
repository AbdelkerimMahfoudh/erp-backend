#!/usr/bin/env bash
# A new platform administrator, invited (0115; the owner's brief of 2026-11-01). Prints no code, no secret.
#
#   deploy/production/admin-invitation.sh invite <email> <name…> --confirm api.tsxmr.com
#   deploy/production/admin-invitation.sh resume <email>         --confirm api.tsxmr.com
#   deploy/production/admin-invitation.sh revoke <email>         --confirm api.tsxmr.com
#   deploy/production/admin-invitation.sh delete                 # remove every handover file now
#   deploy/production/admin-invitation.sh sweep                  # remove the files no longer needed (the timer runs it)
#
# `invite` and `resume` run prisma/platform-admin-invitation.ts in the tools container. Its standard output — one
# line, the setup code — goes into a shell variable and from there into a handover file created atomically (a mode-600
# temporary file renamed into place) under $BASE/admin-invitations (mode 700): outside the checkout, the deployment
# bundles, SECRETS_DIR, BACKUP_DIR and the off-site archive's paths, and never in a log. Only the file's path is printed.
# The file holds the setup code and nothing else.
#
# The operator reads it in their own session (`cat <path>`), passes the code on privately, and runs `delete` at once.
# Whatever happens, a transient timer (erp-admin-invitation-sweep, every five minutes) shreds a file as soon as its
# invitation is spent, expired or withdrawn, and stops itself when none is left. The database keeps a keyed digest of
# the code and its expiry only.
#
# Never touches an active administrator: the program refuses one on every command.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"

DIR=$BASE/admin-invitations
SWEEP_UNIT=erp-admin-invitation-sweep
SELF=$PRODUCTION_DIR/admin-invitation.sh
command=${1:-}

handover_dir() {
  umask 077
  mkdir -p "$DIR"
  chmod 700 "$DIR"
}

# The program, with the code on standard output only (never a terminal: compose run -T).
program() {
  compose --profile tools run --rm --no-deps -T -e ADMIN_INVITATION_HANDOVER=1 tools \
    npx ts-node --transpile-only prisma/platform-admin-invitation.ts "$@"
}

write_handover() { # the program's output line: CODE <admin-id> <expires> <code>
  local line=$1 tag id expires code tmp path
  read -r tag id expires code <<< "$line"
  [ "$tag" = CODE ] && [[ $id =~ ^[0-9a-f]{32}$ ]] && [ -n "$code" ] || die "the program gave no setup code; nothing was written."
  handover_dir
  tmp=$(mktemp "$DIR/.handover.XXXXXX")
  printf '%s\n' "$code" > "$tmp"
  chmod 600 "$tmp"
  path=$DIR/$id.code
  mv -f "$tmp" "$path"
  unset code line
  echo "Setup code written to $path (mode 600; valid until $expires). It is not shown here."
  echo "Read it in your own session, pass it on privately, then delete it at once:"
  echo "  $SELF delete"
  start_sweep
}

start_sweep() {
  if systemctl is-active --quiet "$SWEEP_UNIT.timer" 2>/dev/null; then return 0; fi
  sudo -n systemd-run --quiet --unit="$SWEEP_UNIT" --uid="$(id -u)" --gid="$(id -g)" \
    --on-active=5min --on-unit-active=5min "$SELF" sweep \
    && echo "The sweep timer shreds the file once the invitation is spent, expired or withdrawn." \
    || echo "WARNING: the sweep timer could not start; run '$SELF delete' yourself after the handover." >&2
}

# 1 while the invitation behind <admin-id> can still be spent, 0 otherwise. Read-only, by the database's own clock.
pending() {
  local id=$1 n
  n=$(compose exec -T db sh -c 'MYSQL_PWD="$(cat /secrets/backup.pw)" mysql --socket=/var/run/mysqld/mysqld.sock -u phonestore_backup -N -B -e "$1"' sh \
    "SELECT COUNT(*) FROM phonestore.platform_admins WHERE id = UNHEX('$id') AND admin_state = 'invited' AND deleted_at IS NULL AND setup_code_expires_at > NOW(6)" \
    < /dev/null 2>/dev/null || echo 1)
  [ "$n" = 1 ]
}

shred_file() { shred -u -z "$1" 2>/dev/null || rm -f "$1"; }

case "$command" in
  invite)
    require_confirm "$@"
    take_lock
    email=${2:?usage: admin-invitation.sh invite <email> <name…> --confirm $API_HOST}
    name=()
    for a in "${@:3}"; do [ "$a" = --confirm ] && break; name+=("$a"); done
    [ ${#name[@]} -gt 0 ] || die "give the administrator's name."
    out=$(program issue "$email" "${name[@]}") || die "the invitation was refused (above). Nothing was written."
    write_handover "$out"; unset out
    ;;
  resume)
    require_confirm "$@"
    take_lock
    email=${2:?usage: admin-invitation.sh resume <email> --confirm $API_HOST}
    out=$(program resume "$email") || die "refused (above). Nothing was written."
    write_handover "$out"; unset out
    ;;
  revoke)
    require_confirm "$@"
    take_lock
    program revoke "${2:?usage: admin-invitation.sh revoke <email> --confirm $API_HOST}"
    "$SELF" sweep
    ;;
  delete)
    [ -d "$DIR" ] || { echo "No handover file."; exit 0; }
    n=0
    for f in "$DIR"/*.code "$DIR"/.handover.*; do [ -e "$f" ] || continue; shred_file "$f"; n=$((n + 1)); done
    echo "Deleted $n handover file(s)."
    ;;
  sweep)
    left=0
    if [ -d "$DIR" ]; then
      for f in "$DIR"/.handover.*; do [ -e "$f" ] && shred_file "$f"; done
      for f in "$DIR"/*.code; do
        [ -e "$f" ] || continue
        id=$(basename "$f" .code)
        if pending "$id"; then left=$((left + 1)); else shred_file "$f"; echo "Shredded the handover file of $id: no longer needed."; fi
      done
    fi
    if [ "$left" = 0 ] && systemctl is-active --quiet "$SWEEP_UNIT.timer" 2>/dev/null; then
      sudo -n systemctl stop "$SWEEP_UNIT.timer" 2>/dev/null || true
    fi
    ;;
  *)
    die "usage: admin-invitation.sh invite <email> <name…> | resume <email> | revoke <email> (each with --confirm $API_HOST) | delete | sweep"
    ;;
esac
