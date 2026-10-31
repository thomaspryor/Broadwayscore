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
#   create_session: allowed (BRO-5040, owner 2026-10-11: "Trigger sessions
#     yourself"). It was denied 2026-10-05 (BRO-4664) in favour of START-NOW
#     cards, but the board worker takes one card per firing and its queue ran
#     ~100-200 cards deep, so important work waited weeks. The owner accepts
#     one approval tap per started session. How to start and follow one:
#     .claude/CLOUD.md "Starting a worker session". Denied for a misspelled Broadwayscore
#     source_url: it starts in /home/user without project commands or hooks (BRO-5068); and with no `BUDGET: <1-12>h` prompt line (BRO-5673: ran 8-28 h uncapped) or `REPORT-BACK:` line (BRO-5781).
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
  mcp__Claude_Code_Remote__create_session|mcp__claude-code-remote__create_session)
    # BRO-5228: an omitted model inherits the parent's Opus and skips the card model policy.
    m="$(printf '%s' "$input" | jq -r '(.tool_input.model // "" | if type == "string" then . else tojson end | ascii_downcase | gsub("^\\s+|\\s+$"; "") | sub("\\[[^]]*\\]$"; "")) as $m | if $m == "" then "none" elif ($m | test("fable|mythos")) then "fable" elif ($m | test("^claude-(sonnet|haiku)-[0-9]")) then "ok" elif ($m | test("^claude-opus-[0-9]") | not) then "bad" elif (.tool_input.prompt // "" | tostring | test("(^|\\n)\\s*MODEL-REASON:[ \\t]*\\S")) then "ok" else "opus" end' 2>/dev/null)"
    how='Run `node scripts/session-model.js BRO-N [BRO-M ...]` (no card: `--no-card`) and pass its `model`.'
    case "$m" in
      none) deny "Blocked: create_session needs an explicit model; without one the session inherits yours (usually Opus) and skips the card model policy (BRO-5228). $how" ;;
      fable) deny "Blocked: worker sessions never run on Fable (scripts/lib/bsc-next-model.js). $how" ;;
      bad) deny "Blocked: create_session model must be a full id (claude-sonnet-<version> or claude-opus-<version>). $how" ;;
      opus) deny "Blocked: an Opus session needs a \`MODEL-REASON: <why>\` line in its prompt (session-model.js modelReason, or the owner asked); otherwise use Sonnet (BRO-5228). $how" ;;
    esac
    url="$(printf '%s' "$input" | jq -r '.tool_input.source_url // ""' 2>/dev/null)"; canon='https://github.com/thomaspryor/Broadwayscore'
    names="$(printf '%s' "$url" | jq -Rr 'ascii_downcase | gsub("^\\s+|\\s+$"; "") | (capture("github\\.com[:/]+(?<o>[^/]+)/(?<r>[^/?#]+?)(\\.git)?(/.*)?$") | .o + "/" + .r) // ""' 2>/dev/null)"
    if [ "$names" = "thomaspryor/broadwayscore" ] && [ "$url" != "$canon" ]; then
      deny "Blocked: source_url must be exactly $canon (that spelling: https, capital B, no .git, no trailing slash). Any other form starts the new session in /home/user instead of the project, so it loads none of the project's commands (/ship-check, /what-else, /wrap-up) or Stop hooks (BRO-5068). Retry with source_url \"$canon\"."
    fi
    [ "$url" = "$canon" ] && miss="$(printf '%s' "$input" | jq -r '.tool_input.prompt // "" | tostring | [(if test("(^|\\n)\\s*BUDGET:[ \\t]*([1-9]|1[0-2])h\\b") then empty else "a `BUDGET: <hours>h` line (1-12, usually 6h) so it stops on its own: at the budget it lands what is done, reports on its card, files the rest, and ends (BRO-5673)" end), (if test("(^|\\n)\\s*REPORT-BACK:[ \\t]*\\S") then empty else "a `REPORT-BACK:` line, so this session learns it finished without the owner messaging it (BRO-5781). Paste: REPORT-BACK: as your final action (finished, landed, refused, or stopped at BUDGET), send_message your parent session (session_id \"@parent\") one line: card, outcome, land run URL" end)] | join("; and ")' 2>/dev/null)" && [ -n "$miss" ] && deny "Blocked: a Broadwayscore worker session needs $miss (.claude/CLOUD.md 'Starting a worker session')."
    # BRO-6684 (Broadwayscore sessions only): an Opus session must be Opus by the card policy (+ daily Opus budget) or carry OWNER-ASKED-OPUS:, with BUDGET <= 4h.
    # Fails open; kill switch OPUS_BUDGET_DISABLED=1.
    if [ "$url" = "$canon" ]; then
      opusout="$(printf '%s' "$input" | node "$(cd "$(dirname "$0")/../.." && pwd)/scripts/opus-launch-check-hook.js" 2>/dev/null)"
      [ -n "$opusout" ] && { printf '%s\n' "$opusout"; exit 0; }
    fi
    # BRO-6088: allowed create_session -> advisory if this session's own card is plan-only (never denies; script fails open, kill switch PLAN_ONLY_CREATE_SESSION_DISABLE=1).
    printf '%s' "$input" | node "$(cd "$(dirname "$0")/../.." && pwd)/scripts/plan-only-create-session-hook.js" 2>/dev/null
    ;;
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
esac
exit 0
