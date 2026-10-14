#!/usr/bin/env bash
# BRO-5359 Stop hook: refuse SAFE TO EXIT after a hollow /ship-check. Logic and rules: scripts/lib/review-coverage.mjs. Fails open.
command -v node >/dev/null 2>&1 || exit 0
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/scripts/lib/review-coverage.mjs"
[ -f "$LIB" ] || exit 0
exec node "$LIB" --stop-hook
