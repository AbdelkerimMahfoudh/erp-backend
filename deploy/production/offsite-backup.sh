#!/usr/bin/env bash
# The nightly off-site copy to the Hetzner Storage Box (docs/112 §4). An addition to backup.sh, never a replacement.
#
#   sudo deploy/production/offsite-backup.sh      (what erp-offsite-backup.service runs, from this checkout)
#
# Under the deployment lock: a fresh backup.sh dump (age-encrypted), then one Borg archive (keyfile-blake2: encrypted
# and authenticated; the key and passphrase stay on this server) of the paths in docs/112 §1, then a check of that
# archive and the 7/4/6 retention. On success it writes BACKUP_DIR/offsite-latest and pings the dead-man's switch;
# on failure it pings /fail. The ping carries no data. Prints no secret.
# The units are installed and compared by deploy/production/install-offsite.sh. First run by hand on 2026-10-31 from
# a copy outside the repository; brought here with the same steps, run from the checkout like every other script.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
CHECKOUT=$(dirname "$DEPLOY_DIR")
[ "$DEPLOY_PROFILE" = production ] || die "offsite-backup.sh runs on production only."

# The two backup-only secrets live outside SECRETS_DIR (relocated 2026-11-01: setup-secrets.sh manages that directory).
OPS_SECRETS=/srv/erp-production/ops/secrets
PING_FILE=$OPS_SECRETS/healthchecks_ping_url
ping_hc() { [ -s "$PING_FILE" ] && curl -fsS -m 10 --retry 3 -o /dev/null "$(cat "$PING_FILE")$1" || true; }
on_exit() { local rc=$?; [ "$rc" -eq 0 ] || ping_hc /fail; }
trap on_exit EXIT
ping_hc /start

take_lock
export BORG_REPO=ssh://u705821-sub1@u705821.your-storagebox.de:23/./borg
export BORG_PASSCOMMAND="cat $OPS_SECRETS/borg_passphrase"
export BORG_RSH="ssh -i /root/.ssh/storagebox-backup -o UserKnownHostsFile=/root/.ssh/known_hosts.storagebox -o StrictHostKeyChecking=yes -o BatchMode=yes -o ServerAliveInterval=30"
export BORG_REMOTE_PATH=borg-1.2

# backup.sh under our lock (IN_DEPLOY skips its own take_lock, as in deploy.sh).
IN_DEPLOY=1 "$CHECKOUT/deploy/production/backup.sh"
DUMP=$(ls -1t "$BACKUP_DIR"/phonestore-*.sql.gz.age | head -n 1)
# This job runs as root; the deployment account keeps owning its backups (restore-drill.sh reads them as that account).
OWNER=$(stat -c %U:%G "$BACKUP_DIR")
chown "$OWNER" "$DUMP" "$DUMP.sha256"

VOLS=/var/lib/docker/volumes
ARCHIVE=erp-production-$(date -u +%Y%m%dT%H%M%SZ)
START=$(date +%s)
# The newest dump only (older ones are in earlier archives), and the deployment record by name.
RECORD=()
for f in current-images.env deployments.log offsite-restore-proof offsite-latest; do
  [ -e "$BACKUP_DIR/$f" ] && RECORD+=("$BACKUP_DIR/$f")
done
borg create --compression zstd,6 --exclude-caches \
  "::$ARCHIVE" \
  "$DUMP" "$DUMP.sha256" \
  "${RECORD[@]}" \
  "$API_ENV_FILE" "$BASE"/api.env.pre-* "$CHECKOUT/deploy/production/stack.env" \
  "$SECRETS_DIR" \
  "$BASE/web" \
  "$VOLS/erp-production_uploads/_data" "$VOLS/erp-production_caddy-data/_data"
borg check --archives-only --last 1
borg prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --glob-archives 'erp-production-*'
borg compact

SIZE=$(borg info --json "::$ARCHIVE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["archives"][0]["stats"]["deduplicated_size"])')
printf 'archive=%s\nfinished_at=%s\nseconds=%s\ndedup_bytes=%s\ndump=%s\n' "$ARCHIVE" "$(date -u +%FT%TZ)" \
  "$(( $(date +%s) - START ))" "$SIZE" "$(basename "$DUMP")" > "$BACKUP_DIR/offsite-latest"
chmod 600 "$BACKUP_DIR/offsite-latest"; chown "$OWNER" "$BACKUP_DIR/offsite-latest"
echo "offsite ok: $ARCHIVE"
ping_hc ""
