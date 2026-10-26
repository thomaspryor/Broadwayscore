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
# Cloud-only in effect: CLAUDE_CODE_REMOTE_SESSION_ID is set only in cloud
# sessions, so a local session passes through.
# Kill switch: LAND_CANCEL_GUARD_OFF=1, or the file
# $HOME/.claude/LAND_CANCEL_GUARD_OFF (an MCP call cannot carry an env prefix).
# Tests inject the run as LAND_CANCEL_GUARD_RUN_JSON instead of calling gh.

input=$(cat)
[ "${LAND_CANCEL_GUARD_OFF:-0}" = "1" ] && exit 0
[ -e "$HOME/.claude/LAND_CANCEL_GUARD_OFF" ] && exit 0
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0

run_ids=""
case "$tool_name" in
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
    case "$cmd" in *cancel*) ;; *) exit 0 ;; esac
    # One segment per command (split on && || ; | and newlines), quotes
    # stripped, so a -R on another command (ls -R) or a number elsewhere
    # cannot steer the match.
    while IFS= read -r seg; do
      seg=$(printf '%s' "$seg" | tr -d "\"'")
      case "$seg" in *gh*cancel*) ;; *) continue ;; esac
      # Another repo named with -R/--repo in this gh call is not ours.
      if printf '%s' "$seg" | grep -Eq -- '(^| )(-R|--repo)([ =]|$)' && ! printf '%s' "$seg" | grep -Eiq -- '(-R|--repo)[ =]+thomaspryor/broadwayscore( |$)'; then continue; fi
      id=""
      if printf '%s' "$seg" | grep -Eq '(^| )gh +run +cancel( |$)'; then
        rest=$(printf '%s' "$seg" | sed -E 's/.*gh +run +cancel( |$)//')
        id=$(printf '%s' "$rest" | grep -Eio 'github\.com/thomaspryor/broadwayscore/actions/runs/[0-9]+' | grep -Eo '[0-9]+$' | head -1)
        [ -n "$id" ] || id=$(printf '%s' "$rest" | tr ' ' '\n' | grep -Ex '[0-9]{6,}' | head -1)
      elif printf '%s' "$seg" | grep -Eiq '(^| )gh +api .*repos/(thomaspryor/broadwayscore|\{owner\}/\{repo\}|:owner/:repo)/actions/runs/[0-9]+/(force-)?cancel'; then
        id=$(printf '%s' "$seg" | grep -Eo 'actions/runs/[0-9]+/(force-)?cancel' | grep -Eo '[0-9]+' | head -1)
      fi
      [ -n "$id" ] && run_ids="$run_ids $id"
    done < <(printf '%s\n' "$cmd" | sed -E 's/(&&|\|\||;|\|)/\n/g') ;;
  mcp__github__actions_run_trigger)
    method=$(printf '%s' "$input" | jq -r '.tool_input.method // empty' 2>/dev/null)
    [ "$method" = "cancel_workflow_run" ] || exit 0
    owner=$(printf '%s' "$input" | jq -r '.tool_input.owner // empty' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    repo=$(printf '%s' "$input" | jq -r '.tool_input.repo // empty' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    [ "$owner/${repo%.git}" = "thomaspryor/broadwayscore" ] || exit 0
    run_ids=$(printf '%s' "$input" | jq -r '.tool_input.run_id // empty' | tr -d '[:space:]') ;;
  *) exit 0 ;;
esac
[ -n "${run_ids// /}" ] || exit 0

sid=${CLAUDE_CODE_REMOTE_SESSION_ID:-}
sid=${sid#cse_}; sid=${sid#session_}
[ -n "$sid" ] || exit 0

for run_id in $run_ids; do
if [ -n "${LAND_CANCEL_GUARD_RUN_JSON:-}" ]; then run=$LAND_CANCEL_GUARD_RUN_JSON
else run=$(timeout 15 gh api "repos/thomaspryor/Broadwayscore/actions/runs/$run_id" 2>/dev/null) || continue
fi
path=$(printf '%s' "$run" | jq -r '.path // empty' 2>/dev/null)
case "$path" in .github/workflows/land.yml*) ;; *) continue ;; esac
msg=$(printf '%s' "$run" | jq -r '.head_commit.message // empty' 2>/dev/null)
printf '%s' "$msg" | grep -Eq "^Claude-Session: .*${sid}" && continue

branch=$(printf '%s' "$run" | jq -r '.head_branch // "?"' 2>/dev/null)
echo "🛑 BLOCKED: Land run $run_id ($branch) belongs to another session (its head commit has no Claude-Session trailer for this session). Cancelling it strands that session's land for an hour (BRO-6276). The landing queue parks and resumes runs itself: leave it alone. If this run truly must stop, ask the session that pushed $branch, or the owner. If it is your own run and its tip is a merge commit without your trailer, or for an emergency override, create \$HOME/.claude/LAND_CANCEL_GUARD_OFF." >&2
exit 2
done
exit 0
