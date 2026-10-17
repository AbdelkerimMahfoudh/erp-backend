#!/usr/bin/env bash
# The smoke test from the host, against the public HTTPS name (docs/99 §9). Extra arguments pass through, e.g.
#   deploy/staging/smoke.sh --commit <sha> --allowed-origin https://staging-portal.tsxmr.com
# The tools image carries Node; host networking lets it reach the public name the way a phone does.
source "$(dirname "$0")/lib.sh"
docker run --rm --network host "${TOOLS_IMAGE:-erp-api-tools:staging}" node deploy/staging/smoke.mjs "https://$STAGING_API_HOST" "$@"
