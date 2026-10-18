#!/usr/bin/env bash
# The smoke test from the host (docs/100 §9.1), read-only and unauthenticated. Extra arguments pass through, e.g.
#   deploy/production/smoke.sh --commit <sha>
# Production: against https://api.tsxmr.com, the certificate checked. Rehearsal: against the local edge on 127.0.0.1,
# whose certificate is Caddy's own local authority (--insecure-local: the TLS and redirect checks are skipped there).
source "$(dirname "$0")/lib.sh"
: "${TOOLS_IMAGE:?no tools image recorded in current-images.env}"
if [ "$DEPLOY_PROFILE" = rehearsal ]; then
  docker run --rm --network host --add-host "$API_HOST:127.0.0.1" "$TOOLS_IMAGE" \
    node deploy/staging/smoke.mjs "https://$API_HOST:${EDGE_HTTPS_BIND##*:}" --environment production --expect-hsts --insecure-local "$@"
else
  docker run --rm --network host "$TOOLS_IMAGE" \
    node deploy/staging/smoke.mjs "https://$API_HOST" --environment production --expect-hsts "$@"
fi
