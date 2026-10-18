#!/usr/bin/env bash
# An encrypted, authenticated backup of the production schema (docs/100 §5).
#
#   deploy/production/backup.sh
#
# mysqldump runs inside the database container as phonestore_backup (read-only, local socket); its output streams to
# the host, is compressed and is encrypted with age (X25519 + ChaCha20-Poly1305: authenticated — a modified or
# truncated file fails to decrypt, it never restores silently wrong) to the recipient(s) in SECRETS_DIR/backup.age-recipients.
# Those are PUBLIC keys: the identity that decrypts lives off this server (the owner's password manager and private
# folder), so the server can write backups it cannot read, and a lost server does not take the means of restoring
# with it. The plaintext never touches the disk. Output: phonestore-<UTC>.sql.gz.age and its .sha256 (for transfer
# checks), mode 600, the newest 14 kept. Copy them off the host (docs/100 §5): a backup on the machine it protects is
# not a backup.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
[ -n "${IN_DEPLOY:-}" ] || take_lock
command -v age > /dev/null || die "age is not installed on this host (sudo apt-get install age)."
RECIPIENTS=$SECRETS_DIR/backup.age-recipients
[ -s "$RECIPIENTS" ] || die "missing $RECIPIENTS — the PUBLIC age key(s) of the backup identity (docs/100 §5)."
grep -qvE '^(age1[0-9a-z]{58}|#.*|)$' "$RECIPIENTS" && die "$RECIPIENTS must hold age public keys only (age1…), never an identity."

mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME=phonestore-$STAMP.sql.gz.age
OUT=$BACKUP_DIR/$NAME
trap 'rm -f "$OUT.part"' EXIT

# --single-transaction: a consistent InnoDB snapshot without locking the shop out.
# --routines --triggers --events: the append-only triggers are part of the schema.
# --hex-blob: BINARY(16) keys survive as hex, not as bytes a locale can mangle (docs/22 §2).
# mysqldump writes its completion line only when it finished: a truncated dump is the failure nobody notices until the
# restore. The awk stage passes the plaintext through unchanged and fails unless that line went past — checked as it
# streams, before encryption, because the server cannot decrypt afterwards. Every stage's status is then checked.
set +e
compose exec -T db sh -c 'MYSQL_PWD="$(cat /secrets/backup.pw)" exec mysqldump --socket=/var/run/mysqld/mysqld.sock \
    -u phonestore_backup --single-transaction --routines --triggers --events --no-tablespaces --hex-blob \
    --set-gtid-purged=OFF phonestore' \
  | awk '{ print } /^-- Dump completed on / { done = 1 } END { exit done ? 0 : 3 }' \
  | gzip -9 \
  | age --encrypt -R "$RECIPIENTS" -o "$OUT.part"
status=("${PIPESTATUS[@]}")
set -e
[ "${status[0]}" = 0 ] || die "backup FAILED: mysqldump exited ${status[0]}."
[ "${status[1]}" = 0 ] || die "backup FAILED: no completion marker (a truncated dump)."
[ "${status[2]}" = 0 ] && [ "${status[3]}" = 0 ] || die "backup FAILED: compression or encryption exited ${status[2]}/${status[3]}."
mv -f "$OUT.part" "$OUT"
chmod 600 "$OUT"
(cd "$BACKUP_DIR" && sha256sum "$NAME" > "$NAME.sha256" && chmod 600 "$NAME.sha256")
echo "backup ok: $NAME ($(du -h "$OUT" | cut -f1)) — age-encrypted to $(grep -c '^age1' "$RECIPIENTS") off-host key(s); this server cannot decrypt it."

KEEP=${KEEP:-14}
{ ls -1t "$BACKUP_DIR"/phonestore-*.sql.gz.age 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old" "$old.sha256"; done
