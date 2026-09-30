#!/usr/bin/env bash
# An encrypted, verified backup of the application database (docs/22 §2, docs/48 §8.3).
#
#   BACKUP_PASSPHRASE_FILE=/etc/phonestore/backup.key \
#   MYSQL_USER=phonestore_backup MYSQL_PWD_FILE=/etc/phonestore/backup.pw \
#   DB=phonestore OUT_DIR=/var/backups/phonestore deploy/backup-encrypted.sh
#
# What it produces: <OUT_DIR>/<db>-<UTC stamp>.sql.gz.enc (AES-256-CBC with a
# PBKDF2-derived key, via openssl) and a .sha256 beside it. What it proves
# before it exits 0: the ciphertext decrypts with the passphrase, the plaintext
# gunzips, and the dump ends with the completion marker mysqldump writes only
# when it finished — a truncated dump is the failure mode nobody notices until
# the restore. The plaintext never touches the disk.
#
# Credentials come from files (mode 600), never from arguments: arguments are
# visible in the process list and in shell history.
#
# Restore (see deploy/restore-drill.sh):
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass file:$BACKUP_PASSPHRASE_FILE -in x.sql.gz.enc | gunzip | mysql …
set -euo pipefail
DB=${DB:-phonestore}
OUT_DIR=${OUT_DIR:-./backups}
MYSQL_USER=${MYSQL_USER:-phonestore_backup}
: "${BACKUP_PASSPHRASE_FILE:?set BACKUP_PASSPHRASE_FILE (a file holding the passphrase, mode 600)}"
: "${MYSQL_PWD_FILE:?set MYSQL_PWD_FILE (a file holding the database password, mode 600)}"
CONN=()
if [ -n "${MYSQL_SOCKET:-}" ]; then CONN=(--socket "$MYSQL_SOCKET"); else CONN=(-h "${MYSQL_HOST:-127.0.0.1}" -P "${MYSQL_PORT:-3306}" --protocol=TCP); fi
export MYSQL_PWD; MYSQL_PWD=$(cat "$MYSQL_PWD_FILE")

mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$OUT_DIR/$DB-$STAMP.sql.gz.enc"

# --single-transaction: a consistent InnoDB snapshot without locking the shop out.
# --routines --triggers --events: the append-only triggers are part of the schema.
# --hex-blob: BINARY(16) keys survive as hex, not as bytes a locale can mangle (docs/22 §2).
# --no-tablespaces: the backup account holds no PROCESS-level tablespace rights.
mysqldump "${CONN[@]}" -u "$MYSQL_USER" \
  --single-transaction --routines --triggers --events --no-tablespaces --hex-blob \
  --set-gtid-purged=OFF "$DB" \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$OUT"
chmod 600 "$OUT"
sha256sum "$OUT" > "$OUT.sha256"

# Verify: decrypt + decompress in memory, and demand mysqldump's own completion line.
TAIL=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$OUT" | gunzip | tail -c 400)
if ! grep -q "Dump completed on" <<<"$TAIL"; then
  echo "backup FAILED verification: no completion marker (truncated dump?)" >&2
  rm -f "$OUT" "$OUT.sha256"
  exit 1
fi
TABLES=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$OUT" | gunzip | grep -c '^CREATE TABLE' || true)
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1), $TABLES tables, sha256 in $OUT.sha256)"

# Retention: keep the newest N (default 14). Older encrypted files are removed here;
# the off-host copy (docs/48 §8.3) is a separate job and keeps its own retention.
KEEP=${KEEP:-14}
ls -1t "$OUT_DIR"/"$DB"-*.sql.gz.enc 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do rm -f "$old" "$old.sha256"; done
