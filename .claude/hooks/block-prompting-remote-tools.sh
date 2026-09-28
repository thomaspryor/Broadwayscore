#!/usr/bin/env bash
# PreToolUse hook on the cloud-session tools send_later, create_trigger and
# add_repo (BRO-4236). They carry requiresUserInteraction, so they prompt the
# owner on their phone in every mode, even with an allow rule. Deny the calls
# that have a prompt-free equivalent before the prompt appears.
#
# Scope, on purpose:
#   send_later / create_trigger: denied unless initiation is human_request or
#     human_schedule (the owner asked for it, so a confirmation is expected).
#     Claude's own check-ins use ScheduleWakeup, Monitor or PR subscriptions.
#   add_repo: denied only for thomaspryor/Broadwayscore when the session's
#     project checkout already is that repo. Every other repo passes through.
# Fails open (exit 0, no decision) on missing jq or unparseable input.
# Kill switch: REMOTE_TOOL_BLOCKER_DISABLE=1.

if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi
[ -n "$REMOTE_TOOL_BLOCKER_DISABLE" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
tool="$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)" || exit 0

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

case "$tool" in
  mcp__Claude_Code_Remote__send_later|mcp__claude-code-remote__send_later|\
  mcp__Claude_Code_Remote__create_trigger|mcp__claude-code-remote__create_trigger)
    initiation="$(printf '%s' "$input" | jq -r '.tool_input.initiation // ""' 2>/dev/null)"
    case "$initiation" in human_request|human_schedule) exit 0 ;; esac
    deny "Blocked: send_later and create_trigger put an approval prompt on the owner's phone every time (BRO-4236), so they are reserved for reminders or schedules the owner's own message asked for. For your own check-ins: ScheduleWakeup (always pass a prompt; max 3600s) to resume this session later, Monitor to wait on a command in this turn, or subscribe_pr_activity when a PR exists. Do not retry with the other scheduling tool."
    ;;
  mcp__Claude_Code_Remote__add_repo|mcp__claude-code-remote__add_repo)
    owner="$(printf '%s' "$input" | jq -r '.tool_input.owner // "" | ascii_downcase' 2>/dev/null)"
    repo="$(printf '%s' "$input" | jq -r '.tool_input.repo // "" | ascii_downcase' 2>/dev/null)"
    [ "$owner/$repo" = "thomaspryor/broadwayscore" ] || exit 0
    origin="$(git -C "${CLAUDE_PROJECT_DIR:-.}" config --get remote.origin.url 2>/dev/null | tr '[:upper:]' '[:lower:]')"
    case "$origin" in
      */thomaspryor/broadwayscore|*/thomaspryor/broadwayscore.git|*/thomaspryor/broadwayscore/) ;;
      *) exit 0 ;;
    esac
    deny "Blocked: Broadwayscore is this session's own repository, attached when the session started, so add_repo would only put an approval prompt on the owner's phone (BRO-4236). Use the existing checkout. If a push or GitHub write is refused for lack of access, stop and tell the owner instead of retrying add_repo."
    ;;
esac
exit 0
