#!/usr/bin/env bash
# PreToolUse hook (BRO-7534): allow the Linear connector's save_comment and save_issue
# without the permission prompt, whatever the server is called.
#
# The owner's cloud sessions kept prompting for Linear comments even with the connector on
# always-allow and Auto mode (BRO-7526). A permissions.allow rule only matches one server
# name, and cloud containers name the connector mcp__Linear__*, mcp__claude_ai_Linear__* or
# mcp__<uuid>__* (scripts/lib/root-cause-stop.mjs). A hook sees the tool name, so it can match
# all three. Only create/update writes are allowed: delete_* tools are untouched and prompt as
# before. Known trade-off (ship-check): the uuid branch cannot tell Linear from another uuid-named
# connector that also exposes save_comment/save_issue; accepted, both are low-risk writes. Fails open (exit 0, no decision) on missing jq or unparseable input.
# Kill switch: ALLOW_LINEAR_WRITES_DISABLE=1.

if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi
[ -n "$ALLOW_LINEAR_WRITES_DISABLE" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

tool="$(jq -r '.tool_name // ""' 2>/dev/null)" || exit 0
shopt -s nocasematch
if [[ "$tool" =~ ^mcp__(Linear|claude_ai_Linear|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__(save_comment|save_issue)$ ]]; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"Linear comment and issue writes are pre-approved by the owner (BRO-7534)."}}'
fi
exit 0
