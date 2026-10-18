#!/usr/bin/env bash
# The restore drill (docs/22 §3, docs/48 §8.3): prove a backup comes back.
#
#   BACKUP_PASSPHRASE_FILE=… MYSQL_USER=phonestore_admin MYSQL_PWD_FILE=… \
#   BACKUP=/var/backups/phonestore/phonestore-20260930T140000Z.sql.gz.enc \
#   SOURCE_DB=phonestore deploy/restore-drill.sh
#
# Restores the encrypted dump into a NEW database (<source>_drill_<stamp>),
# never over the live one, with the source's character set and collation, then
# compares it with the source: table, trigger and row counts, every table's
# CHECKSUM, every trigger body, BINARY(16) keys, and that the append-only guard
# came back. Drops the drill database at the end unless KEEP_DRILL=1. Every step
# is printed so the run can be pasted into docs/22 as the record.
#
# A server with the binary log on refuses to create the dump's triggers for an
# account without SUPER unless it sets log_bin_trust_function_creators=1
# (ERROR 1419; deploy/mysql-identities.sql).
#
# BACKUP=- reads the dump, already decrypted but still gzipped, on standard
# input: the production backups are age-encrypted to a key that never lives
# on the server, so deploy/production/restore-drill.sh checks the checksum,
# decrypts on the host with the identity brought in for the drill, and pipes
# the stream here. Everything after the decryption is the same.
set -euo pipefail
: "${BACKUP:?set BACKUP (the .sql.gz.enc to restore, or - for a decrypted stream on stdin)}"
[ "$BACKUP" = "-" ] || : "${BACKUP_PASSPHRASE_FILE:?}"
: "${MYSQL_PWD_FILE:?}"
SOURCE_DB=${SOURCE_DB:-phonestore}
MYSQL_USER=${MYSQL_USER:-phonestore_admin}
CONN=()
if [ -n "${MYSQL_SOCKET:-}" ]; then CONN=(--socket "$MYSQL_SOCKET"); else CONN=(-h "${MYSQL_HOST:-127.0.0.1}" -P "${MYSQL_PORT:-3306}" --protocol=TCP); fi
export MYSQL_PWD; MYSQL_PWD=$(cat "$MYSQL_PWD_FILE")
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DRILL="${SOURCE_DB}_drill_${STAMP}"
q() { mysql "${CONN[@]}" -u "$MYSQL_USER" -N -B -e "$1"; }

echo "=== restore drill $STAMP: $BACKUP → $DRILL"
if [ "$BACKUP" = "-" ]; then
  echo "checksum: checked by the caller before decrypting (stdin)"
else
  sha256sum -c "$BACKUP.sha256" >/dev/null && echo "checksum ok" || { echo "checksum FAILED"; exit 1; }
fi
decrypted() { if [ "$BACKUP" = "-" ]; then cat; else openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$BACKUP"; fi; }
# The copy takes the source's defaults, not fixed ones: a trigger's or a
# routine's variables take the database's collation, so a copy with other
# defaults is not the database it claims to be.
read -r SRC_CHARSET SRC_COLLATION <<<"$(q "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$SOURCE_DB'")"
[ -n "${SRC_COLLATION:-}" ] || { echo "cannot read the character set of $SOURCE_DB — is SOURCE_DB right, and can $MYSQL_USER see it?"; exit 1; }
q "CREATE DATABASE \`$DRILL\` CHARACTER SET $SRC_CHARSET COLLATE $SRC_COLLATION"
echo "created $DRILL ($SRC_CHARSET / $SRC_COLLATION, as $SOURCE_DB)"
# A drill that stops before its verdict leaves no copy behind, KEEP_DRILL or not: an incomplete copy must never be
# taken for a restore. (Found by the production rehearsal: an authenticated decryption streams the chunks it has
# verified, so a backup damaged near its end had already half-filled the copy when it was refused.)
DRILL_DONE=0
trap '[ "$DRILL_DONE" = 1 ] || { q "DROP DATABASE IF EXISTS \`$DRILL\`" > /dev/null 2>&1; echo "dropped the incomplete $DRILL"; }' EXIT
# DEFINER clauses name the original creator; on a server where that account is
# absent the restore would fail (docs/22 §3.1). Strip them so the objects are
# created by the restoring account — on schema lines only: mysqldump writes
# every row on an INSERT line, and a row whose text holds DEFINER=`x`@`y` (a
# product's name, say) is data that a blind substitution would corrupt without
# a word (docs/22 §3). --comments keeps the comments inside trigger bodies, so
# the bodies come back byte-identical; the client drops them otherwise.
decrypted \
  | gunzip \
  | LC_ALL=C sed -E '/^(INSERT|REPLACE) INTO /!s/DEFINER=`[^`]+`@`[^`]+`//g' \
  | mysql --comments "${CONN[@]}" -u "$MYSQL_USER" "$DRILL"
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
# Every BINARY(16) key of the tenant roots, as one digest: a key that came back as different bytes fails here.
for t in companies users; do
  cmp "binary keys of $t (digest)" "SET SESSION group_concat_max_len = 1000000000; SELECT IFNULL(MD5(GROUP_CONCAT(HEX(id) ORDER BY id SEPARATOR ',')), 'none') FROM \`__DB__\`.\`$t\`"
done
cmp "money: sales total"  "SELECT IFNULL(SUM(total),0) FROM \`__DB__\`.sales"
cmp "money: payments"     "SELECT IFNULL(SUM(amount),0) FROM \`__DB__\`.payments"
cmp "trigger bodies" "SET SESSION group_concat_max_len = 1000000000; SELECT MD5(GROUP_CONCAT(CONCAT_WS('|', TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT) ORDER BY TRIGGER_NAME SEPARATOR '\\n')) FROM information_schema.triggers WHERE trigger_schema='__DB__'"
# Every table's content, not only its row count: a restore that changed one
# value in one row must not pass.
differ=0; tables=0
for t in $(q "SELECT table_name FROM information_schema.tables WHERE table_schema='$SOURCE_DB' AND table_type='BASE TABLE' ORDER BY table_name"); do
  tables=$((tables+1))
  a=$(q "CHECKSUM TABLE \`$SOURCE_DB\`.\`$t\`" | awk '{print $NF}'); b=$(q "CHECKSUM TABLE \`$DRILL\`.\`$t\`" | awk '{print $NF}')
  [ "$a" = "$b" ] || { echo "FAIL table content differs: $t"; differ=$((differ+1)); }
done
if [ "$differ" -eq 0 ]; then echo "PASS every table's CHECKSUM matches ($tables tables)"; else fails=$((fails+differ)); fi
# The append-only guard must be back: an UPDATE as the app account is refused
# BY THE TRIGGER. A refusal for want of a grant proves nothing about the
# trigger — the application account's grants name the live schema only.
if [ -n "${APP_PW:-}" ]; then
  if out=$(MYSQL_PWD="$APP_PW" mysql "${CONN[@]}" -u phonestore_app -e "UPDATE \`$DRILL\`.audit_logs SET reason='x' WHERE id=(SELECT * FROM (SELECT MIN(id) FROM \`$DRILL\`.audit_logs) t)" 2>&1); then
    echo "FAIL append-only trigger did not come back (the app could rewrite an audit row)"; fails=$((fails+1))
  elif grep -q "append-only" <<<"$out"; then
    echo "PASS append-only trigger restored (the app's UPDATE refused by the trigger)"
  elif grep -q "ERROR 1142" <<<"$out"; then
    echo "SKIP append-only probe: phonestore_app has no grant on $DRILL, so the trigger was never reached (the trigger bodies were compared above)"
  else
    echo "FAIL append-only probe refused for another reason: $(head -1 <<<"$out")"; fails=$((fails+1))
  fi
fi

DRILL_DONE=1
# Kept only when asked AND every comparison passed: a copy that differs from its source is never left to be used.
if [ "${KEEP_DRILL:-0}" = "1" ] && [ "$fails" -eq 0 ]; then echo "kept $DRILL"; else q "DROP DATABASE \`$DRILL\`"; echo "dropped $DRILL"; fi
echo "=== drill $([ $fails -eq 0 ] && echo PASSED || echo "FAILED ($fails)")"
[ "$fails" -eq 0 ]
