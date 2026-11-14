#!/usr/bin/env bash
# Self-skip if the user-level master hook exists (local CLI scenario).
# Cloud sandboxes do not have ~/.claude/hooks/, so the project copy runs there.
# There is no Mac master for this hook yet, so the project copy runs on the Mac
# too (interactive sessions and headless jobs in repo worktrees alike).
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ] && [ "${BASH_SOURCE[0]}" != "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi
# compact-state.sh — compaction checkpoint (Claude spend review 2026-10-01, plan item 4).
#
# Registered twice in .claude/settings.json:
#   PreCompact (any trigger)          -> write the checkpoint for this session
#   SessionStart (matcher "compact")  -> print it back as additionalContext
# All logic lives in scripts/lib/compact-state.js (unit-tested); `auto` picks
# the mode from hook_event_name / source in the stdin JSON. Fail-open on every
# path: a missing node, repo or transcript must never block compaction.
INPUT=$(cat 2>/dev/null || true)
G="$(git rev-parse --show-toplevel 2>/dev/null)"
R="${CLAUDE_PROJECT_DIR:-$G}"
[ -n "$R" ] && [ -f "$R/scripts/lib/compact-state.js" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
printf '%s' "$INPUT" | node "$R/scripts/lib/compact-state.js" auto 2>/dev/null || true
exit 0
