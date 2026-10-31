#!/usr/bin/env bash
# planning-tier-advisory.sh (BRO-6249) — PreToolUse on Write.
# Three-tier planning rule: warns (then, from 2026-11-07, blocks) when a Write starts a
# SUBSTANTIAL new system (4th new file in a new directory, a new workflow, a new secret)
# with no plan-review verdict and no "OWNER-PLAN-APPROVED: <quote>" in the session.
# Moderate tier nudges only. Logic: scripts/lib/planning-tier.js (+ planning-tier-hook.js).
# Fails open on every error. Kill switch: PLANNING_TIER_MODE=off ; warn-only: =warn.
# EDITING: write to a temp file, `bash -n` it, then move into place (a syntax error
# here wedges Write for every session; see infra-plan-review-gate.sh).
[ "${PLANNING_TIER_MODE:-auto}" = "off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0
G="$(git rev-parse --show-toplevel 2>/dev/null)"; R="${CLAUDE_PROJECT_DIR:-$G}"
H="$R/scripts/lib/planning-tier-hook.js"
[ -f "$H" ] || exit 0
exec node "$H"
