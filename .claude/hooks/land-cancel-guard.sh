#!/usr/bin/env bash
# PreToolUse hook (BRO-6276): a session cancels only its own Land runs.
#
# On 2026-10-26 05:15-05:23Z another session's cancel calls killed four
# BRO-6276 Land runs mid-flight; the mutex read them as stranded and they
# waited an hour for the stranded pass. The mutex parks runs with the workflow
# token, never through a session, so no session needs to cancel a Land run it
# did not push. Refused here:
#   - Bash: `gh run cancel <id>` and `gh api …/actions/runs/<id>/(force-)cancel`
#   - mcp__github__actions_run_trigger with method cancel_workflow_run
# for a thomaspryor/Broadwayscore run of land.yml whose head commit does not
# carry this session's Claude-Session trailer. Other workflows' runs pass.
#
# Fails open when the run cannot be read or this session's id is unknown.
# Kill switch: LAND_CANCEL_GUARD_OFF=1, or the file
# $HOME/.claude/LAND_CANCEL_GUARD_OFF (an MCP call cannot carry an env prefix).
# Tests inject the run as LAND_CANCEL_GUARD_RUN_JSON instead of calling gh.

input=$(cat)
[ "${LAND_CANCEL_GUARD_OFF:-0}" = "1" ] && exit 0
[ -e "$HOME/.claude/LAND_CANCEL_GUARD_OFF" ] && exit 0
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0

run_id=""
case "$tool_name" in
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
    case "$cmd" in *cancel*) ;; *) exit 0 ;; esac
    # Another repo named with -R/--repo is not ours.
    if printf '%s' "$cmd" | grep -Eq -- '(-R|--repo)[ =]+' && ! printf '%s' "$cmd" | grep -Eiq -- '(-R|--repo)[ =]+thomaspryor/broadwayscore'; then exit 0; fi
    run_id=$(printf '%s' "$cmd" | grep -Eo 'gh +run +cancel +([^ ]+ +)*[0-9]{6,}' | grep -Eo '[0-9]{6,}$' | head -1)
    if [ -z "$run_id" ]; then
      printf '%s' "$cmd" | grep -Eiq 'repos/thomaspryor/broadwayscore/actions/runs/[0-9]+/(force-)?cancel|repos/\{owner\}/\{repo\}/actions/runs/[0-9]+/(force-)?cancel' || exit 0
      run_id=$(printf '%s' "$cmd" | grep -Eo 'actions/runs/[0-9]+/(force-)?cancel' | grep -Eo '[0-9]+' | head -1)
    fi ;;
  mcp__github__actions_run_trigger)
    method=$(printf '%s' "$input" | jq -r '.tool_input.method // empty' 2>/dev/null)
    [ "$method" = "cancel_workflow_run" ] || exit 0
    owner=$(printf '%s' "$input" | jq -r '.tool_input.owner // empty' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    repo=$(printf '%s' "$input" | jq -r '.tool_input.repo // empty' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    [ "$owner/${repo%.git}" = "thomaspryor/broadwayscore" ] || exit 0
    run_id=$(printf '%s' "$input" | jq -r '.tool_input.run_id // empty' | tr -d '[:space:]') ;;
  *) exit 0 ;;
esac
[ -n "$run_id" ] || exit 0

if [ -n "${LAND_CANCEL_GUARD_RUN_JSON:-}" ]; then run=$LAND_CANCEL_GUARD_RUN_JSON
else run=$(timeout 15 gh api "repos/thomaspryor/Broadwayscore/actions/runs/$run_id" 2>/dev/null) || exit 0
fi
path=$(printf '%s' "$run" | jq -r '.path // empty' 2>/dev/null)
case "$path" in .github/workflows/land.yml*) ;; *) exit 0 ;; esac

sid=${CLAUDE_CODE_REMOTE_SESSION_ID:-}
sid=${sid#cse_}; sid=${sid#session_}
[ -n "$sid" ] || exit 0
msg=$(printf '%s' "$run" | jq -r '.head_commit.message // empty' 2>/dev/null)
printf '%s' "$msg" | grep -Eq "^Claude-Session: .*${sid}" && exit 0

branch=$(printf '%s' "$run" | jq -r '.head_branch // "?"' 2>/dev/null)
echo "🛑 BLOCKED: Land run $run_id ($branch) belongs to another session (its head commit has no Claude-Session trailer for this session). Cancelling it strands that session's land for an hour (BRO-6276). The landing queue parks and resumes runs itself: leave it alone. If this run truly must stop, ask the session that pushed $branch, or the owner. Emergency override: create \$HOME/.claude/LAND_CANCEL_GUARD_OFF." >&2
exit 2
