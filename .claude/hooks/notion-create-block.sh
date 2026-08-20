#!/usr/bin/env bash
# Self-skip if the user-level master hook exists (local CLI scenario).
# Cloud sandboxes do not have ~/.claude/hooks/, so the project copy runs there.
# Avoids double-firing identical logic on local sessions where the user-level
# Claude Code settings.json already wires the master at ~/.claude/hooks/<this-script-name>.
# ── Board gate escape hatch ─────────────────────────────────────────────
# See board-gate-escape-hatch.md (Broadwayscore repo root) — the owner-facing
# off switch for every board gate on this machine.
#
# This check is FIRST, before stdin is read, before jq, and before any board
# reachability probe. The failure mode it exists for is "the board is reachable
# but wrong", so a probe running ahead of it could hang for its full timeout on
# every gated command — which is the outage, not the remedy.
#
# Prefix match, not equality: the documented no-terminal path is a TextEdit
# save, and TextEdit appends .txt whether the owner wants it or not.
# -e OR -L so a dangling symlink still counts as "present".
# Honoured unconditionally: an escape hatch with conditions is not an escape hatch.
for _hatch in "$HOME/.claude/BOARD_GATE_DISABLED"*; do
  if [ -e "$_hatch" ] || [ -L "$_hatch" ]; then exit 0; fi
done
# Env-var twin, matching the idiom of the other kill switches in this directory
# (INFRA_REVIEW_GATE_DISABLE, VISUAL_QA_DISABLE) so engineers get a familiar path.
[ "${BOARD_GATE_DISABLED:-0}" = "1" ] && exit 0
# ── end board gate escape hatch ─────────────────────────────────────────

if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi
# PreToolUse hook: if a notion-brain.js create previously failed IN THIS SESSION,
# block the next tool call and force a retry.
#
# The breadcrumb is session-scoped (/tmp/notion-create-failed-${session_id}) so
# a failed create in a parallel session can't block this one. Without scoping,
# any cross-session leftover would spin new sessions on their very first tool call.

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)

# No session_id → can't scope, pass through (fail open).
if [ -z "$session_id" ]; then
  exit 0
fi

BREADCRUMB="/tmp/notion-create-failed-${session_id}"

if [ ! -f "$BREADCRUMB" ]; then
  exit 0
fi

# A notion create failed and hasn't been retried successfully.
# Don't block notion-brain.js commands (need to allow the retry!)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
if echo "$command" | grep -q 'notion-brain'; then
  exit 0
fi

cat >&2 <<'EOF'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ NOTION CARD CREATION FAILED — FIX BEFORE CONTINUING

A previous `notion-brain.js create` was rejected by validation.
The card was NOT created. You must fix the --notes and retry
before proceeding with other work.

Common fix: add ## Suggested approach and ## Acceptance criteria
sections to the --notes argument.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
exit 2
