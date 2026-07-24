#!/usr/bin/env bash
# Self-skip if the user-level master hook exists (local CLI scenario).
# Cloud sandboxes do not have ~/.claude/hooks/, so the project copy runs there.
# Avoids double-firing identical logic on local sessions where the user-level
# Claude Code settings.json already wires the master at ~/.claude/hooks/<this-script-name>.
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
