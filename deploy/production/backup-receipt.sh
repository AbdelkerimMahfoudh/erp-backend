#!/usr/bin/env bash
# Proof that the newest backup also exists off this host, which deploy.sh requires before it starts (D227).
#
#   backup-receipt.sh same <checksum-a> <checksum-b>     two real SHA-256 values that are equal, or a refusal
#   backup-receipt.sh record <backup-name> <off-host-checksum>
#   backup-receipt.sh check
#
# On 2026-11-01 a hand-written comparison of two EMPTY values printed "OK", and a deployment started with no off-host
# copy. So nothing here compares with a bare `=`: a value counts only if it is 64 hex characters, and every file must
# exist and be non-empty. Any doubt refuses. `backup-offhost.sh`, on the operator's machine, calls `same` and `record`.
# BACKUP_DIR comes from the environment. RECEIPT_MAX_AGE_SECONDS: how old a receipt may be (default 4 hours).
set -euo pipefail

die() { echo "Refusing: $*" >&2; exit 2; }
sum_ok() { [[ "${1:-}" =~ ^[0-9a-f]{64}$ ]]; }

same() {
  sum_ok "${1:-}" || die "the first checksum is empty or malformed."
  sum_ok "${2:-}" || die "the second checksum is empty or malformed."
  [ "$1" = "$2" ] || die "the checksums differ."
}

file_sum() {
  [ -s "$1" ] || die "the backup $(basename "$1") is missing or empty."
  sha256sum "$1" | cut -d' ' -f1
}

# A name, never a path: the receipt must not be able to point outside the backup directory.
name_ok() {
  [[ "${1:-}" =~ ^phonestore-[0-9]{8}T[0-9]{6}Z\.sql\.gz\.age$ ]] || die "the backup name is empty or malformed."
}

command=${1:-}
case "$command" in
  same)
    same "${2:-}" "${3:-}"
    echo "checksums match"
    ;;
  record | check)
    BACKUP_DIR=${BACKUP_DIR:-}
    [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] || die "BACKUP_DIR is not set to a directory."
    RECEIPT=$BACKUP_DIR/offhost-verified
    if [ "$command" = record ]; then
      name_ok "${2:-}"
      same "$(file_sum "$BACKUP_DIR/$2")" "${3:-}"
      printf '%s %s %s\n' "$2" "$3" "$(date -u +%s)" > "$RECEIPT.part"
      chmod 600 "$RECEIPT.part"
      mv -f "$RECEIPT.part" "$RECEIPT"
      echo "off-host copy recorded: $2"
    else
      [ -s "$RECEIPT" ] || die "no off-host copy is recorded. Run backup-offhost.sh from the operator's machine first."
      read -r name sum at _ < "$RECEIPT" || true
      name_ok "${name:-}"
      same "$(file_sum "$BACKUP_DIR/$name")" "${sum:-}"
      [[ "${at:-}" =~ ^[0-9]+$ ]] || die "the receipt has no time."
      age=$(($(date -u +%s) - at))
      [ "$age" -ge 0 ] && [ "$age" -le "${RECEIPT_MAX_AGE_SECONDS:-14400}" ] || die "the off-host copy $name is too old. Take a fresh one."
      echo "off-host copy verified: $name"
    fi
    ;;
  *)
    die "usage: backup-receipt.sh same <a> <b> | record <name> <checksum> | check"
    ;;
esac
