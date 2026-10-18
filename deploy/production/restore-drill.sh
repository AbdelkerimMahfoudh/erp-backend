#!/usr/bin/env bash
# Restore an age backup into a throw-away copy and prove it is whole (docs/100 §5; deploy/restore-drill.sh).
#
#   deploy/production/restore-drill.sh --identity <file> [--offsite storage-box|laptop] [backup.sql.gz.age]
#
# The identity is the backup's PRIVATE age key. It never lives on this server: the operator brings it in for the drill
# (to /dev/shm, memory only, mode 600) and removes it after. The file's .sha256 is checked first (a transfer error is
# told apart from tampering); age then authenticates every byte as it decrypts. The live schema is never touched: the
# copy is phonestore_drill_<stamp>, compared with the live schema (tables, triggers, row counts, money sums, binary
# keys, trigger bodies, every table's CHECKSUM), then dropped (KEEP_DRILL=1 keeps it: the restore path, docs/100 §11).
#
# --offsite names where the file came back from. A PASSED drill then writes BACKUP_DIR/offsite-restore-proof, which
# the preflight requires (kind=storage-box) before any messaging channel opens sign-ups (docs/100 §5).
source "$(dirname "$0")/lib.sh"
[ -n "${IN_DEPLOY:-}" ] || take_lock
IDENTITY="" OFFSITE="" FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY=${2:-}; shift 2 ;;
    --offsite) OFFSITE=${2:-}; shift 2 ;;
    *) FILE=$1; shift ;;
  esac
done
command -v age > /dev/null || die "age is not installed on this host."
[ -n "$IDENTITY" ] && [ -s "$IDENTITY" ] || die "--identity <file>: the backup's private key, brought in for the drill (docs/100 §5)."
case "$IDENTITY" in /dev/shm/*) ;; *) die "the identity is read from /dev/shm only (memory, never the disk)." ;; esac
case "$OFFSITE" in ""|storage-box|laptop) ;; *) die "--offsite is storage-box or laptop." ;; esac
FILE=${FILE:-$(ls -1t "$BACKUP_DIR"/phonestore-*.sql.gz.age 2>/dev/null | head -n 1)}
[ -n "$FILE" ] && [ -s "$FILE" ] || die "no backup to restore."
DIR=$(cd "$(dirname "$FILE")" && pwd); NAME=$(basename "$FILE")
[ -s "$DIR/$NAME.sha256" ] || die "missing $NAME.sha256 beside the backup."
(cd "$DIR" && sha256sum -c --quiet "$NAME.sha256") || die "the checksum of $NAME does not match: the copy is damaged."
echo "checksum ok: $NAME"

set +e
age --decrypt -i "$IDENTITY" "$DIR/$NAME" \
  | compose exec -T -e KEEP_DRILL="${KEEP_DRILL:-0}" db bash -c 'BACKUP=- MYSQL_PWD_FILE=/secrets/admin.pw \
      MYSQL_USER=phonestore_admin SOURCE_DB=phonestore APP_PW="$(cat /secrets/app.pw)" \
      MYSQL_SOCKET=/var/run/mysqld/mysqld.sock bash /deploy/restore-drill.sh'
status=("${PIPESTATUS[@]}")
set -e
[ "${status[0]}" = 0 ] || die "age could not decrypt $NAME (wrong identity, or the file was modified): nothing restored."
[ "${status[1]}" = 0 ] || die "the restore drill FAILED for $NAME."

if [ -n "$OFFSITE" ]; then
  printf 'kind=%s\nfile=%s\nsha256=%s\nrestored_at=%s\nproject=%s\n' "$OFFSITE" "$NAME" "$(cut -d' ' -f1 "$DIR/$NAME.sha256")" \
    "$(date -u +%FT%TZ)" "$PROJECT" > "$BACKUP_DIR/offsite-restore-proof"
  chmod 600 "$BACKUP_DIR/offsite-restore-proof"
  echo "off-site restore proof recorded: kind=$OFFSITE"
fi
