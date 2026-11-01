#!/usr/bin/env bash
# Install, update or compare the nightly off-site backup (docs/112 §4) from this checkout.
#
#   sudo deploy/production/install-offsite.sh --check     # compare what is installed with this checkout; change nothing
#   sudo deploy/production/install-offsite.sh --install   # install or update, then compare again
#
# What it installs, root-owned: the systemd units erp-offsite-backup.service and .timer (644), then enables the timer;
# the service runs deploy/production/offsite-backup.sh from this checkout, like every other script. It never creates, reads or prints a secret:
# the Borg key, its passphrase (SECRETS_DIR/borg_passphrase), the Storage Box key (/root/.ssh/storagebox-backup), its
# pinned host key and the healthchecks ping URL (SECRETS_DIR/healthchecks_ping_url) are set up once by the operator
# (docs/112 §2–§3) and only named here. An update is the same command after the checkout moved forward.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
[ "$DEPLOY_PROFILE" = production ] || die "the off-site backup runs on production only."
HERE=$PRODUCTION_DIR
UNITS=/etc/systemd/system
MODE=${1:-}
[ "$(id -u)" = 0 ] || { echo "Refusing: run as root (sudo)." >&2; exit 2; }
case "$MODE" in --check|--install) ;; *) echo "usage: $0 --check|--install" >&2; exit 2 ;; esac

pairs=("$HERE/systemd/erp-offsite-backup.service:$UNITS/erp-offsite-backup.service"
       "$HERE/systemd/erp-offsite-backup.timer:$UNITS/erp-offsite-backup.timer")

compare() {
  local drift=0 pair src dst
  for pair in "${pairs[@]}"; do
    src=${pair%%:*} dst=${pair#*:}
    if [ ! -e "$dst" ]; then echo "  missing    $dst"; drift=1
    elif cmp -s "$src" "$dst"; then echo "  identical  $dst"
    else echo "  DIFFERENT  $dst"; drift=1; fi
  done
  [ -x "$HERE/offsite-backup.sh" ] && echo "  executable $HERE/offsite-backup.sh" || { echo "  not executable $HERE/offsite-backup.sh"; drift=1; }
  for f in /root/.ssh/storagebox-backup /root/.ssh/known_hosts.storagebox /srv/erp-production/secrets/borg_passphrase; do
    [ -s "$f" ] && echo "  present    $f" || { echo "  missing    $f (operator setup, docs/112 §2–§3)"; drift=1; }
  done
  systemctl is-enabled --quiet erp-offsite-backup.timer && echo "  enabled    erp-offsite-backup.timer" \
    || { echo "  disabled   erp-offsite-backup.timer"; drift=1; }
  return $drift
}

if [ "$MODE" = --install ]; then
  install -m 644 -o root -g root "$HERE/systemd/erp-offsite-backup.service" "$HERE/systemd/erp-offsite-backup.timer" "$UNITS/"
  systemctl daemon-reload
  systemctl enable --now erp-offsite-backup.timer
fi
echo "== off-site backup: installed vs this checkout"
if compare; then echo "off-site backup: IN SYNC"; else echo "off-site backup: DRIFT (run --install, or finish the operator setup)"; exit 1; fi
