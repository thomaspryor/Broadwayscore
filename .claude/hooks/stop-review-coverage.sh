#!/usr/bin/env bash
# stop-review-coverage.sh (BRO-5359) — Stop hook, repo-only (no ~/.claude master, so no
# cloud-parity drift). Refuses "SAFE TO EXIT" after a /ship-check or /code-review whose
# reviewers (Claude review-panelist Agent + an external reviewer) never ran.
# All logic: scripts/lib/review-coverage.mjs --stop-hook (tested by
# scripts/lib/review-coverage.test.mjs). Fails open on a missing node or lib.
# Kill switch: SHIP_CHECK_COVERAGE_DISABLE=1. Bypass: a `NO-SHIP-CHECK: <reason>` line in the message.
[ "${SHIP_CHECK_COVERAGE_DISABLE:-0}" = "1" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../../scripts/lib/review-coverage.mjs"
[ -f "$LIB" ] || exit 0
exec node "$LIB" --stop-hook
