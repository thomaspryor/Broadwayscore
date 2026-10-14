#!/usr/bin/env bash
# BRO-5359 Stop hook: refuse SAFE TO EXIT after a hollow /ship-check. Rules and logic: scripts/lib/review-coverage.mjs. Fails open.
# Top-level on purpose: scripts/install-home-claude-config.js wires only .claude/hooks/<name>.sh into home-rooted sessions.
command -v node >/dev/null 2>&1 || exit 0
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/review-coverage.mjs"
[ -f "$LIB" ] || exit 0
exec node "$LIB" --stop-hook
