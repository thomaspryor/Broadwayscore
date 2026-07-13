#!/usr/bin/env bash
# pre-push-review-gate.sh — PreToolUse hook on Bash. The prose-independent
# review gate (Notion 39c637c5, incident 2026-07-12 gate-ab monitor).
#
# Problem: finish-line-gate.sh (Stop hook) only enforces the review chain when
# the assistant's final message CLAIMS completion. A session that ships code
# across turns ending in questions never emits a claim, so substantial
# unreviewed code lands on main (gate-ab monitor: 1 P0 + 4 P1s found only by
# user-prompted review). This hook anchors enforcement to the push itself.
#
# Blocks push-ingress commands (git push, gh pr merge, scripts/*push*, deploy
# workflows — same ingress set as the visual gate) when:
#   - the push's gated diff (src/, scripts/, .github/workflows/ code files vs
#     origin/main) exceeds the line budget (30) AND
#   - no fresh pass verdict exists in .claude/review-verdicts.jsonl
#     (written by /ship-check, /code-review, /second-opinion via
#     scripts/lib/review-gate.mjs --query=record) AND
#   - no `NO-SHIP-CHECK: <reason ≥15 chars>` in the in-flight assistant turn AND
#   - no user "ship immediately for: <reason>" override (review-gate namespace)
#
# Decision logic lives in scripts/lib/review-gate.mjs (testable); transcript
# scanning in scripts/lib/transcript-scan.mjs. Emergency disable:
# REVIEW_GATE_DISABLE=1. Fail-open on any infrastructure error — this gate
# must never wedge an unrelated push.

# Self-skip preamble (project copy only): if the user-level master exists,
# it is the registered one on local CLI — let it fire and exit here. On cloud
# sandboxes ~/.claude/hooks/ doesn't exist, so this project copy runs.
if [ -f "$HOME/.claude/hooks/pre-push-review-gate.sh" ] && \
   [ "${BASH_SOURCE[0]}" != "$HOME/.claude/hooks/pre-push-review-gate.sh" ]; then
  exit 0
fi

[ "${REVIEW_GATE_DISABLE:-0}" = "1" ] && exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
transcript=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
tool_use_id=$(echo "$input" | jq -r '.tool_use_id // empty' 2>/dev/null)

[ -z "$command" ] && exit 0

# SESSION_ROOT: git root of the CWD (may be a linked worktree).
SESSION_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$SESSION_ROOT" ] && exit 0

# CANONICAL_ROOT: the main-worktree root (shared ledger + canonical libs).
_GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -z "$_GIT_COMMON" ]; then
  CANONICAL_ROOT="$SESSION_ROOT"
else
  case "$_GIT_COMMON" in
    /*) CANONICAL_ROOT=$(dirname "$_GIT_COMMON") ;;
    *)  CANONICAL_ROOT=$(dirname "$SESSION_ROOT/$_GIT_COMMON") ;;
  esac
fi

# The gate only applies to repos that carry the libs (i.e. Broadwayscore).
# Canonical copies, so a worktree branch can't shadow the gate's logic.
SCAN="$CANONICAL_ROOT/scripts/lib/transcript-scan.mjs"
GATE="$CANONICAL_ROOT/scripts/lib/review-gate.mjs"
[ ! -f "$SCAN" ] && exit 0
[ ! -f "$GATE" ] && exit 0

# Is this a push-ingress command?
PUSH_RESULT=$(node "$SCAN" --query=push-ingress --command="$command" 2>/dev/null)
IS_PUSH=$(echo "$PUSH_RESULT" | jq -r '.isPush // false' 2>/dev/null)
[ "$IS_PUSH" != "true" ] && exit 0

# Cross-repo push guard: `cd <other-repo> && git push` is not our gate.
_FIRST_CD=$(printf '%s' "$command" | grep -oE '(^|[[:space:];&|])cd[[:space:]]+[^[:space:];&|<>]+' | head -1 | sed 's/^[[:space:];&|]*cd[[:space:]]*//')
if [ -n "$_FIRST_CD" ]; then
  case "$_FIRST_CD" in
    ~/*)  _FIRST_CD="$HOME/${_FIRST_CD#~/}" ;;
    ~)    _FIRST_CD="$HOME" ;;
  esac
  if [ -d "$_FIRST_CD" ]; then
    _CD_REPO=$(git -C "$_FIRST_CD" rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$_CD_REPO" ] && [ "$_CD_REPO" != "$CANONICAL_ROOT" ]; then
      exit 0
    fi
  fi
fi

# Resolve what's being pushed: `git push origin <branch>` from a worktree
# pushes <branch>, not the worktree HEAD (same awk as the visual gate).
DIFF_REF="HEAD"
_PUSH_REF=$(printf '%s' "$command" | awk '{
  in_push=0
  skipped_remote=0
  for(i=1;i<=NF;i++){
    tok=$i
    gsub(/^[;&|]+/, "", tok)
    if(tok=="push") { in_push=1; continue }
    if(!in_push) continue
    if(tok~/^-/) continue
    if(!skipped_remote) { skipped_remote=1; continue }
    if(tok!="" && tok!~/^-/) { print tok; exit }
  }
}' | head -1)
if [ -n "$_PUSH_REF" ] && [ "$_PUSH_REF" != "HEAD" ]; then
  if git -C "$SESSION_ROOT" rev-parse --verify "$_PUSH_REF" >/dev/null 2>&1; then
    DIFF_REF="$_PUSH_REF"
  fi
fi

# The decision. Fail open if the lib errors (never wedge a push on a bug here).
RESULT=$(node "$GATE" --query=push-allowed --repo="$SESSION_ROOT" --ledger-root="$CANONICAL_ROOT" --ref="$DIFF_REF" 2>/dev/null)
[ -z "$RESULT" ] && exit 0
ALLOWED=$(echo "$RESULT" | jq -r '.allowed // false' 2>/dev/null)
[ "$ALLOWED" = "true" ] && exit 0

log_bypass() {
  mkdir -p "$HOME/.claude/logs" 2>/dev/null
  printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$1" "$transcript" "$2" \
    >> "$HOME/.claude/logs/finish-line-bypass.log" 2>/dev/null
}

# NO-SHIP-CHECK: <reason ≥15 chars> in the in-flight assistant turn.
SCAN_ARGS=(--query=bypass-token --token=NO-SHIP-CHECK --transcript="$transcript")
[ -n "$tool_use_id" ] && SCAN_ARGS+=(--tool-use-id="$tool_use_id")
BYPASS_RESULT=$(node "$SCAN" "${SCAN_ARGS[@]}" 2>/dev/null)
HAS_BYPASS=$(echo "$BYPASS_RESULT" | jq -r '.hasBypass // false' 2>/dev/null)
if [ "$HAS_BYPASS" = "true" ]; then
  log_bypass "NO-SHIP-CHECK-PUSH" "$(echo "$BYPASS_RESULT" | jq -r '.line // empty' 2>/dev/null)"
  exit 0
fi

# User override "ship immediately for: <reason>" — own marker namespace so the
# visual gate's consumption of the same phrase doesn't starve this gate.
OVERRIDE_RESULT=$(node "$SCAN" --query=override-active-for-push --transcript="$transcript" --session-id="$session_id" --marker-ns=review-gate --consume=true 2>/dev/null)
OVERRIDE_OK=$(echo "$OVERRIDE_RESULT" | jq -r '.override // false' 2>/dev/null)
if [ "$OVERRIDE_OK" = "true" ]; then
  log_bypass "SHIP-IMMEDIATELY-REVIEW-GATE" "$session_id"
  exit 0
fi

GATED_LINES=$(echo "$RESULT" | jq -r '.gatedLines // "?"' 2>/dev/null)
REASON=$(echo "$RESULT" | jq -r '.reason // "no review verdict"' 2>/dev/null)
FILES=$(echo "$RESULT" | jq -r '(.gatedFiles // [])[:5] | join(" ")' 2>/dev/null)
echo "🛑 BLOCKED: push of $GATED_LINES unreviewed code lines ($REASON). Files: $FILES. This gate fires on the push itself — no completion claim needed. Run /ship-check (or /second-opinion for small diffs) NOW, fix findings, then push; the skill records the verdict automatically. Docs/data-only or pure-revert pushes may bypass with a line starting \`NO-SHIP-CHECK: <specific reason ≥15 chars>\` (logged and audited)." >&2
exit 2
