#!/usr/bin/env bash
# The operator's SMTP delivery proof (docs/100 §7): ONE delivery-test email, through the reviewed SMTP channel, to the
# one test address the owner holds. The API never sends it and its EMAIL_CHANNEL is not touched.
#
#   deploy/production/email-proof.sh --brevo-tracking-off-confirmed [--language en|fr|ar]
#
# Reads three files from SECRETS_DIR/proof (mode 600, put there for the proof and removed after it):
#   smtp_username  smtp_password   the owner's Brevo SMTP login and key (entered through a hidden prompt)
#   recipient                      the owner's test address, one line
# The container gets them read-only, has an outbound network only (no database), and prints the recipient masked and
# the provider's message id as a one-way reference. Each run sends one message; the log line is appended here.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
: "${TOOLS_IMAGE:?no tools image recorded in current-images.env}"
CONFIRMED=0 LANGUAGE=en
while [ $# -gt 0 ]; do
  case "$1" in
    --brevo-tracking-off-confirmed) CONFIRMED=1; shift ;;
    --language) LANGUAGE=${2:-}; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[ "$CONFIRMED" = 1 ] || die "the owner must first confirm Brevo open and click tracking are off (--brevo-tracking-off-confirmed)."
P=$SECRETS_DIR/proof
for f in smtp_username smtp_password recipient; do
  [ -s "$P/$f" ] || die "missing $P/$f."
  [ "$(stat -c %a "$P/$f")" = 600 ] || die "$P/$f must be mode 600."
done
take_lock
set +e
out=$(compose --profile proof run --rm --no-deps email-proof \
  npx ts-node --transpile-only scripts/email-prove.ts --recipient-file /run/proof/recipient --brevo-tracking-off-confirmed --language "$LANGUAGE" 2>&1)
code=$?
set -e
# The script prints only masked and one-way values; keep its last line as the record.
echo "$out" | tail -n 3
printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$PROJECT" "$(echo "$out" | grep -m1 '^email delivery proof:' || echo 'email delivery proof: no result line')" >> "$BACKUP_DIR/email-proofs.log"
exit "$code"
