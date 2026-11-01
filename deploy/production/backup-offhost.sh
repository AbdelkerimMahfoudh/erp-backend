#!/usr/bin/env bash
# Run on the OPERATOR'S machine before a deployment (D227): a fresh backup on the host, a copy here, both checksums
# compared by backup-receipt.sh, and the receipt deploy.sh requires. Stops at the first thing that is not right.
#
#   deploy/production/backup-offhost.sh <ssh-host> <local-directory>
set -euo pipefail

die() { echo "Refusing: $*" >&2; exit 2; }
HOST=${1:-}
DEST=${2:-}
[ -n "$HOST" ] || die "name the ssh host."
[ -n "$DEST" ] && [ -d "$DEST" ] || die "name an existing local directory."
HERE=$(cd "$(dirname "$0")" && pwd)
REMOTE=${REMOTE_CHECKOUT:-/srv/erp-production/erp-backend}
SSH=${SSH_BIN:-ssh}
remote() { "$SSH" -o BatchMode=yes "$HOST" "$@" < /dev/null; }

remote "cd '$REMOTE' && sudo -n deploy/production/backup.sh" | tail -n 1
# The configured directory, as the host's own scripts read it.
BACKUP_DIR=$(remote "cd '$REMOTE' && sudo -n bash -c 'source deploy/production/lib.sh >/dev/null; printf %s \"\$BACKUP_DIR\"'")
[ -n "$BACKUP_DIR" ] || die "the host named no backup directory."
NAME=$(remote "sudo -n bash -c 'cd \"$BACKUP_DIR\" && ls -1t phonestore-*.sql.gz.age | head -n 1'")
[ -n "$NAME" ] || die "the host named no backup."

COPY=$DEST/$NAME
"$SSH" -o BatchMode=yes "$HOST" "sudo -n cat '$BACKUP_DIR/$NAME'" < /dev/null > "$COPY.part"
[ -s "$COPY.part" ] || die "the copy of $NAME is empty."
mv -f "$COPY.part" "$COPY"

HOST_SUM=$(remote "sudo -n sha256sum '$BACKUP_DIR/$NAME'" | cut -d' ' -f1)
LOCAL_SUM=$(sha256sum "$COPY" | cut -d' ' -f1)
tr -d '\r' < "$HERE/backup-receipt.sh" | bash -s -- same "$HOST_SUM" "$LOCAL_SUM"

remote "cd '$REMOTE' && sudo -n bash -c 'source deploy/production/lib.sh >/dev/null; BACKUP_DIR=\"\$BACKUP_DIR\" deploy/production/backup-receipt.sh record \"$NAME\" \"$LOCAL_SUM\"'"
echo "off-host copy ok: $COPY"
