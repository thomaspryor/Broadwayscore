#!/usr/bin/env bash
# PreToolUse hook on the cloud-session tools send_later, create_trigger,
# add_repo (BRO-4236) and list_sessions (BRO-4635). They prompt the owner on
# their phone in every mode, even with an allow rule (list_sessions: seen in
# Auto mode, owner screenshot 2026-10-04). Deny the calls that have a
# prompt-free equivalent before the prompt appears.
#
# Scope, on purpose:
#   send_later / create_trigger: denied unless initiation is human_request (the
#     owner is asking right now, so they are there to confirm). human_schedule
#     re-arms are denied too: they prompt later, often while the owner sleeps,
#     and the unanswered prompt silently ends the watch (BRO-4258).
#   add_repo: denied only for thomaspryor/Broadwayscore when the session's
#     project checkout already is that repo. Every other repo passes through.
#   list_sessions: always denied; get_session by id is pre-approved.
#   create_session: always denied (BRO-4664, owner 2026-10-05: "I still want
#     them to be started. I just don't need to approve them each time"; "don't
#     rely on the Mac Studio"). The prompt-free route is a P0/P1 card with a
#     START-NOW: line, which the hourly cloud worker takes first.
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
    case "$initiation" in human_request) exit 0 ;; esac
    deny "Blocked: send_later and create_trigger put an approval prompt on the owner's phone every time (BRO-4236), so they are reserved for a reminder or schedule the owner is asking for in their current message. Re-arming a watch or loop is blocked too: nobody answers that prompt at night, so the watch would silently stop (BRO-4258). Overnight watches are scheduled up front while the owner is awake; see .claude/CLOUD.md 'Overnight watches'. For your own check-ins: to follow work that must finish (a land.yml run, a deploy), wait in this turn with a run_in_background Bash loop or Monitor (e.g. poll until the land/<name> ref is deleted, which land.yml does on success); subscribe_pr_activity when a PR exists; ScheduleWakeup (always pass a prompt; max 3600s) only as a best-effort nudge, since it can fail to fire. If a watch you are running is now blocked, say so in your status line and next report (no push notification: the owner may be asleep) instead of retrying. Do not retry with the other scheduling tool, and do not relabel initiation: human_request means the owner's own current message asked for this reminder."
    ;;
  mcp__Claude_Code_Remote__add_repo|mcp__claude-code-remote__add_repo)
    owner="$(printf '%s' "$input" | jq -r '.tool_input.owner // "" | ascii_downcase | gsub("^\\s+|\\s+$"; "")' 2>/dev/null)"
    repo="$(printf '%s' "$input" | jq -r '.tool_input.repo // "" | ascii_downcase | gsub("^\\s+|\\s+$"; "") | sub("\\.git$"; "")' 2>/dev/null)"
    [ "$owner/$repo" = "thomaspryor/broadwayscore" ] || exit 0
    origin="$(git -C "${CLAUDE_PROJECT_DIR:-.}" config --get remote.origin.url 2>/dev/null | tr '[:upper:]' '[:lower:]')"
    case "$origin" in
      */thomaspryor/broadwayscore|*/thomaspryor/broadwayscore.git|*/thomaspryor/broadwayscore/) ;;
      *:thomaspryor/broadwayscore|*:thomaspryor/broadwayscore.git) ;;
      *) exit 0 ;;
    esac
    deny "Blocked: Broadwayscore is this session's own repository, attached when the session started, so add_repo would only put an approval prompt on the owner's phone (BRO-4236). Use the existing checkout. If a push or GitHub write is refused for lack of access, stop and tell the owner instead of retrying add_repo."
    ;;
  mcp__Claude_Code_Remote__list_sessions|mcp__claude-code-remote__list_sessions)
    deny "Blocked: list_sessions puts an approval prompt on the owner's phone in every mode, Auto included (BRO-4635). To check a session you started, call get_session with its session id (pre-approved, no prompt). For card workers, read the Linear card state or check for the land/<name> ref instead. If the owner asks which sessions are running, tell them to open the sessions list in the Claude app."
    ;;
  mcp__Claude_Code_Remote__create_session|mcp__claude-code-remote__create_session)
    deny "Blocked: create_session puts an approval prompt on the owner's phone every time, in every mode, and the owner wants sessions started without approvals (BRO-4664). Queue the work and the cloud worker starts the session: file a self-contained P0/P1 card whose notes carry a line 'START-NOW: <why it should not wait>' and a safe-form VERIFY line: node scripts/linear-brain.js create \"<title>\" --dispatch --priority 2 --notes \"START-NOW: ...\n<handoff>\n## Acceptance criteria\nVERIFY: \`<cmd>\`\". The hourly cloud worker takes START-NOW cards before the rest of the queue. Tell the owner it is queued and usually starts within an hour or two; do not ask them to approve anything, and do not rely on the owner's Mac."
    ;;
esac
exit 0
