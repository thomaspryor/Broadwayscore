#!/usr/bin/env bash
# PreToolUse hook (BRO-7534): stop the Linear connector's comment/issue prompts, whatever the
# server is called (mcp__Linear__*, mcp__claude_ai_Linear__*, mcp__<uuid>__*).
#
# 1. In cloud (CLAUDE_CODE_REMOTE) a plain NEW comment or NEW issue is denied with a pointer to
#    scripts/linear-brain.js. The connector's own server policy asks before every create and an
#    allow here does not beat it (observed: decision_reason_rule_source=mcpServerPolicy); the
#    script talks to the Linear API directly and never prompts. Only creates the script can do are
#    redirected (no parentId, labels, assignee, other teams). ALLOW_LINEAR_WRITES_NO_REDIRECT=1 turns
#    the redirect off.
# 2. Everything else the two tools do (updates, richer creates) gets an allow. Deletes are untouched.
#    A write that sets state Done/Canceled gets no decision (linear-brain.js holds the Done gate).
# Known trade-off: the uuid prefix cannot tell Linear from another uuid-named connector that also
# exposes save_comment/save_issue; accepted, both are low-risk writes. Fails open (exit 0, no
# decision) on missing jq or unparseable input. Kill switch: ALLOW_LINEAR_WRITES_DISABLE=1.

if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi
[ -n "$ALLOW_LINEAR_WRITES_DISABLE" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
tool="$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)" || exit 0
state="$(printf '%s' "$input" | jq -r '.tool_input.state // "" | tostring' 2>/dev/null)" || state=""
shopt -s nocasematch
if [[ "$state" =~ ^(done|completed|canceled|cancelled|duplicate)$ ]]; then exit 0; fi
if [[ "$tool" =~ ^mcp__(Linear|claude_ai_Linear|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__(save_comment|save_issue)$ ]]; then
  if [[ "$tool" == *save_comment ]]; then ok='["issue","issueId","body"]'; else ok='["title","description","team","priority"]'; fi
  plain="$(printf '%s' "$input" | jq -r --argjson ok "$ok" '(.tool_input // {}) as $t | if (($t.id // "") == "") and ((($t|keys) - $ok) | length == 0) then "yes" else "" end' 2>/dev/null)" || plain=""
  if [ -n "$CLAUDE_CODE_REMOTE" ] && [ -z "$ALLOW_LINEAR_WRITES_NO_REDIRECT" ] && [ "$plain" = yes ]; then
    S='node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/scripts/linear-brain.js"'
    if [[ "$tool" == *save_comment ]]; then
      how="$S update BRO-N --comment \"\$(cat <<'EOF'"$'\n'"<text>"$'\n'"EOF"$'\n'")\""
    else
      how="$S create \"<title>\" --self|--dispatch|--park \"<reason>\" --notes \"<text>\""
    fi
    jq -n --arg how "$how" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:("Use the repo script, not the connector (no approval prompt, BRO-7534). Run:\n" + $how + "\nThen carry on.")}}'
    exit 0
  fi
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"Linear comment and issue writes are pre-approved by the owner (BRO-7534)."}}'
fi
exit 0
