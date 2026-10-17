#!/usr/bin/env bash
# The staging preflight (docs/99 §5): the API's environment against the staging policy, before anything starts.
source "$(dirname "$0")/lib.sh"
compose --profile tools run --rm --no-deps tools node deploy/staging/preflight.mjs
