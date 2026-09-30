#!/usr/bin/env bash
# The restore drill (docs/22 §3, docs/48 §8.3): prove a backup comes back.
#
#   BACKUP_PASSPHRASE_FILE=… MYSQL_USER=phonestore_admin MYSQL_PWD_FILE=… \
#   BACKUP=/var/backups/phonestore/phonestore-20260930T140000Z.sql.gz.enc \
#   SOURCE_DB=phonestore deploy/restore-drill.sh
#
# Restores the encrypted dump into a NEW database (<source>_drill_<stamp>),
# never over the live one, then compares table counts and row counts with the
# source, checks that the append-only triggers came back, and that BINARY(16)
# keys survived. Drops the drill database at the end unless KEEP_DRILL=1.
# Every step is printed so the run can be pasted into docs/22 as the record.
set -euo pipefail
: "${BACKUP:?set BACKUP (the .sql.gz.enc to restore)}"
: "${BACKUP_PASSPHRASE_FILE:?}"; : "${MYSQL_PWD_FILE:?}"
SOURCE_DB=${SOURCE_DB:-phonestore}
MYSQL_USER=${MYSQL_USER:-phonestore_admin}
CONN=()
if [ -n "${MYSQL_SOCKET:-}" ]; then CONN=(--socket "$MYSQL_SOCKET"); else CONN=(-h "${MYSQL_HOST:-127.0.0.1}" -P "${MYSQL_PORT:-3306}" --protocol=TCP); fi
export MYSQL_PWD; MYSQL_PWD=$(cat "$MYSQL_PWD_FILE")
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DRILL="${SOURCE_DB}_drill_${STAMP}"
q() { mysql "${CONN[@]}" -u "$MYSQL_USER" -N -B -e "$1"; }

echo "=== restore drill $STAMP: $BACKUP → $DRILL"
sha256sum -c "$BACKUP.sha256" >/dev/null && echo "checksum ok" || { echo "checksum FAILED"; exit 1; }
q "CREATE DATABASE \`$DRILL\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
# DEFINER clauses name the original creator; on a server where that account is
# absent the restore would fail (docs/22 §3.1). Strip them so the objects are
# created by the restoring account.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$BACKUP" \
  | gunzip \
  | sed -E 's/DEFINER=`[^`]+`@`[^`]+`//g' \
  | mysql "${CONN[@]}" -u "$MYSQL_USER" "$DRILL"
echo "restored"

fails=0
cmp() { # label sql
  a=$(q "${2//__DB__/$SOURCE_DB}"); b=$(q "${2//__DB__/$DRILL}")
  if [ "$a" = "$b" ]; then echo "PASS $1: $a"; else echo "FAIL $1: source=$a drill=$b"; fails=$((fails+1)); fi
}
cmp "tables"   "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='__DB__'"
cmp "triggers" "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='__DB__'"
for t in companies users sales sale_items payments units audit_logs subscription_events otp_challenges; do
  cmp "rows in $t" "SELECT COUNT(*) FROM \`__DB__\`.\`$t\`"
done
cmp "binary keys intact (first company id)" "SELECT HEX(id) FROM \`__DB__\`.companies ORDER BY id LIMIT 1"
cmp "audit_logs last id"                   "SELECT IFNULL(MAX(id),0) FROM \`__DB__\`.audit_logs"
# The append-only guard must be back: an UPDATE as the app account is refused.
if [ -n "${APP_PW:-}" ]; then
  if MYSQL_PWD="$APP_PW" mysql "${CONN[@]}" -u phonestore_app -e "UPDATE \`$DRILL\`.audit_logs SET reason='x' WHERE id=(SELECT * FROM (SELECT MIN(id) FROM \`$DRILL\`.audit_logs) t)" 2>/dev/null; then
    echo "FAIL append-only trigger did not come back (the app could rewrite an audit row)"; fails=$((fails+1))
  else
    echo "PASS append-only trigger restored (app UPDATE refused)"
  fi
fi

if [ "${KEEP_DRILL:-0}" != "1" ]; then q "DROP DATABASE \`$DRILL\`"; echo "dropped $DRILL"; else echo "kept $DRILL"; fi
echo "=== drill $([ $fails -eq 0 ] && echo PASSED || echo "FAILED ($fails)")"
[ "$fails" -eq 0 ]
