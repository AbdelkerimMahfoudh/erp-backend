#!/usr/bin/env bash
# The production preflight (docs/100 §5): the API's environment against the production policy, before anything starts.
# shellcheck source=deploy/production/lib.sh
source "$(dirname "$0")/lib.sh"
compose --profile tools run --rm --no-deps tools node deploy/production/preflight.mjs
