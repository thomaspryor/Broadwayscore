#!/usr/bin/env bash
# PreToolUse hook on Bash. Blocks push-ingress commands (git push, gh pr merge,
# bash scripts/lib/push-with-retry.sh, gh workflow run deploy, etc.) when:
#   - UI files changed in `git diff origin/main...HEAD` AND
#   - No prior APPROVED entry in the shared ledger for the commits being pushed AND
#   - No "APPROVED: <contentHash>" from the user in their most recent message AND
#   - No "ship immediately for: <reason>" override active AND
#   - No "NO-VERIFY: <reason>" in the in-flight assistant turn AND
#   - No "# NO-VERIFY: <reason ≥15 chars>" shell comment in the gated command
#     itself (added 2026-07-20 — the transcript channel is unreachable at
#     PreToolUse time in current harness builds; uses are logged to
#     ~/.claude/logs/visual-gate-bypass.log)
#
# Bug fixes (2026-06-06):
#   - SESSION_ROOT / CANONICAL_ROOT split: SCAN and ledger now always use the
#     canonical main-worktree root so that (a) a worktree branch that edited
#     transcript-scan.mjs can't shadow the gate's NO-VERIFY detection, and
#     (b) a push approval recorded while in a worktree session is found when
#     pushing from main after merging (shared ledger path).
#   - Cross-repo push guard: `cd ~/broadway-review-texts && git push` no longer
#     fires the gate — the visual-qa gate applies to the Broadwayscore UI repo only.
#
# Logic is delegated to scripts/lib/transcript-scan.mjs and
# scripts/lib/visual-qa-ledger.mjs for testability.

# Self-skip if user-level master exists (matches existing hook convention).
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi

# Emergency disable.
[ "${VISUAL_QA_DISABLE:-0}" = "1" ] && exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
transcript=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
tool_use_id=$(echo "$input" | jq -r '.tool_use_id // empty' 2>/dev/null)

# If we can't see the command or transcript, fail open — don't block legit work.
[ -z "$command" ] && exit 0
[ -z "$transcript" ] && exit 0
[ ! -f "$transcript" ] && exit 0

# SESSION_ROOT: the git root of the current working directory (may be a linked worktree).
SESSION_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$SESSION_ROOT" ] && exit 0

# CANONICAL_ROOT: the main worktree root, consistent across ALL sessions.
# git rev-parse --git-common-dir returns the path to the shared .git directory:
#   - main worktree: returns ".git" (relative)
#   - linked worktrees: returns an absolute path like /abs/path/.git
# dirname of that path is the canonical working-tree root in both cases.
_GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -z "$_GIT_COMMON" ]; then
  CANONICAL_ROOT="$SESSION_ROOT"
else
  case "$_GIT_COMMON" in
    /*) CANONICAL_ROOT=$(dirname "$_GIT_COMMON") ;;
    *)  CANONICAL_ROOT=$(dirname "$SESSION_ROOT/$_GIT_COMMON") ;;
  esac
fi

# SCAN always uses the canonical root's copy — ensures consistent NO-VERIFY
# detection regardless of what changes a worktree branch may have made to
# scripts/lib/transcript-scan.mjs.
SCAN="$CANONICAL_ROOT/scripts/lib/transcript-scan.mjs"
[ ! -f "$SCAN" ] && exit 0

# Quick: is this even a push-ingress command?
PUSH_RESULT=$(node "$SCAN" --query=push-ingress --command="$command" 2>/dev/null)
IS_PUSH=$(echo "$PUSH_RESULT" | jq -r '.isPush // false' 2>/dev/null)
[ "$IS_PUSH" != "true" ] && exit 0

# Cross-repo push guard: if the command cd's into a directory that belongs to
# a DIFFERENT git repository, the visual-qa gate does not apply.
# Handles: `cd ~/broadway-review-texts && git push origin main`
_FIRST_CD=$(printf '%s' "$command" | grep -oE '(^|[[:space:];&|(])cd[[:space:]]+[^[:space:];&|<>)]+' | head -1 | sed 's/^[[:space:];&|(]*cd[[:space:]]*//')
if [ -n "$_FIRST_CD" ]; then
  case "$_FIRST_CD" in
    ~/*)  _FIRST_CD="$HOME/${_FIRST_CD#~/}" ;;
    ~)    _FIRST_CD="$HOME" ;;
  esac
  if [ -d "$_FIRST_CD" ]; then
    _CD_REPO=$(git -C "$_FIRST_CD" rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$_CD_REPO" ] && [ "$_CD_REPO" != "$CANONICAL_ROOT" ]; then
      exit 0  # Push target is a different repo — not our gate to enforce.
    fi
  fi
fi

# Are any UI files changed in what's actually being pushed?
# Parse `git push [flags] [remote] <branch>` to find the explicit push target.
# When in a worktree and running `git push origin main`, HEAD is the worktree
# branch — not what's being pushed. Without this, `git push origin main` from a
# worktree with UI commits incorrectly fires the gate even though main has no
# UI changes.
DIFF_REF="HEAD"
# Extract: `git push [flags] origin <branch>` → the branch after "origin".
# awk: scan tokens; once we see "push", skip to "origin" then take the next non-flag token.
_PUSH_REF=$(printf '%s' "$command" | awk '{
  in_push=0
  skipped_remote=0
  for(i=1;i<=NF;i++){
    tok=$i
    # Strip leading & ; | from token (compound commands)
    gsub(/^[;&|]+/, "", tok)
    if(tok=="push") { in_push=1; continue }
    if(!in_push) continue
    if(tok~/^-/) continue  # skip flags
    if(!skipped_remote) { skipped_remote=1; continue }  # skip remote (origin)
    if(tok!="" && tok!~/^-/) { print tok; exit }
  }
}' | head -1)
if [ -n "$_PUSH_REF" ] && [ "$_PUSH_REF" != "HEAD" ]; then
  # Verify the ref exists locally before using it
  if git -C "$SESSION_ROOT" rev-parse --verify "$_PUSH_REF" >/dev/null 2>&1; then
    DIFF_REF="$_PUSH_REF"
  fi
fi
UI_FILES_CHANGED=$(cd "$SESSION_ROOT" && git diff --name-only "origin/main...$DIFF_REF" 2>/dev/null | grep -E '^(src/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.|src/app/.*\.(tsx|jsx|ts|js)$)' | head -5)
if [ -z "$UI_FILES_CHANGED" ]; then
  # No UI files changed in this branch — push freely.
  exit 0
fi

# NO-VERIFY override in the gated command itself, as a shell comment:
#   git push ...  # NO-VERIFY: <reason ≥15 chars>
# Needed because assistant text blocks are flushed to the transcript AFTER
# PreToolUse fires — and blocked-tool turns' text can be dropped entirely —
# so transcript scans can never see an in-flight NO-VERIFY (observed
# 2026-07-20, session e1dca052). The command string is the one channel
# guaranteed visible at gate time, and it is equally on-the-record for the
# user. Anchored to a `#` comment marker (fanout-model-gate.sh precedent) so
# embedded text — commit messages, heredocs, echoed strings — cannot match;
# ≥15-char reason matches the queryBypassToken convention. (The transcript
# path's looser /NO-VERIFY:\s+\S+/ bar is unreachable in current harness
# builds, so this is the single live bar.) Every use is logged.
_NV_MATCH=$(echo "$command" | grep -oE '(^|[[:space:]])#[[:space:]]*NO-VERIFY:[[:space:]]+.{15,}' | head -1)
if [ -n "$_NV_MATCH" ]; then
  _logdir="${CLAUDE_LOG_DIR:-$HOME/.claude/logs}"
  mkdir -p "$_logdir" 2>/dev/null
  printf '%s\tNO-VERIFY-in-command\t%s\n' "$(date +%s)" "${_NV_MATCH:0:160}" >> "$_logdir/visual-gate-bypass.log" 2>/dev/null
  exit 0
fi

# NO-VERIFY override — scans the in-flight turn containing the gated tool_use.
# Uses CANONICAL SCAN so worktree-specific script variants don't shadow detection.
SCAN_ARGS=(--query=visual-claim-language --transcript="$transcript")
[ -n "$tool_use_id" ] && SCAN_ARGS+=(--tool-use-id="$tool_use_id")
CLAIM_RESULT=$(node "$SCAN" "${SCAN_ARGS[@]}" 2>/dev/null)
HAS_NO_VERIFY=$(echo "$CLAIM_RESULT" | jq -r '.hasNoVerify // false' 2>/dev/null)
[ "$HAS_NO_VERIFY" = "true" ] && exit 0

# Override active for THIS push? If so, write the consume marker and pass.
OVERRIDE_RESULT=$(node "$SCAN" --query=override-active-for-push --transcript="$transcript" --session-id="$session_id" --consume=true 2>/dev/null)
OVERRIDE_OK=$(echo "$OVERRIDE_RESULT" | jq -r '.override // false' 2>/dev/null)
[ "$OVERRIDE_OK" = "true" ] && exit 0

# Current branch — prefer DIFF_REF (the explicit push target) over session HEAD
# so that `git push origin main` from a worktree looks for main's verdict, not
# the worktree branch's verdict.
if [ "$DIFF_REF" != "HEAD" ]; then
  BRANCH="$DIFF_REF"
else
  BRANCH=$(cd "$SESSION_ROOT" && git branch --show-current)
fi

# Verdict path: /visual-qa writes to .claude/visual-qa/<branch>/ relative to
# its CWD (the session root). Check SESSION_ROOT first; fall back to CANONICAL_ROOT
# in case the verdict was written from a different session context.
VERDICT_PATH="$SESSION_ROOT/.claude/visual-qa/$BRANCH/verdict.json"
if [ ! -f "$VERDICT_PATH" ] && [ "$SESSION_ROOT" != "$CANONICAL_ROOT" ]; then
  VERDICT_PATH="$CANONICAL_ROOT/.claude/visual-qa/$BRANCH/verdict.json"
fi

if [ ! -f "$VERDICT_PATH" ]; then
  echo "🛑 BLOCKED: push of UI changes without a visual-qa verdict (branch $BRANCH; UI files: $(echo "$UI_FILES_CHANGED" | tr '\n' ' ')). Run /visual-qa, then plain affirmative from user. Bypass: NO-VERIFY: <reason> | ship immediately for: <reason>." >&2
  exit 2
fi

# Verdict exists. Check schemaVersion, overallPass, contentHash.
SCHEMA_VERSION=$(jq -r '.schemaVersion // 1' "$VERDICT_PATH" 2>/dev/null)
VERDICT_HASH=$(jq -r '.contentHash // .verdictHash // empty' "$VERDICT_PATH" 2>/dev/null)
OVERALL_PASS=$(jq -r '.overallPass // false' "$VERDICT_PATH" 2>/dev/null)

if [ "$SCHEMA_VERSION" != "2" ]; then
  echo "🛑 BLOCKED: verdict.json is stale schema (v$SCHEMA_VERSION, need v2) at $VERDICT_PATH. Re-run /visual-qa. Bypass: NO-VERIFY: <reason>." >&2
  exit 2
fi

if [ -z "$VERDICT_HASH" ]; then
  echo "🛑 BLOCKED: verdict.json malformed (no contentHash) at $VERDICT_PATH. Re-run /visual-qa." >&2
  exit 2
fi

# Ledger check — ALWAYS uses CANONICAL_ROOT so the shared ledger at
# .claude/visual-qa/approvals.jsonl is visible to both worktree sessions
# (when they record approvals) and main-repo sessions (when they push after
# merging a worktree branch). The contentHash match is rebase/squash-tolerant.
LEDGER_RESULT=$(node "$CANONICAL_ROOT/scripts/lib/visual-qa-ledger.mjs" --query=push-allowed --repo="$CANONICAL_ROOT" --current-content-hash="$VERDICT_HASH" 2>/dev/null)
LEDGER_OK=$(echo "$LEDGER_RESULT" | jq -r '.allowed // false' 2>/dev/null)
LEDGER_REASON=$(echo "$LEDGER_RESULT" | jq -r '.reason // empty' 2>/dev/null)
if [ "$LEDGER_OK" = "true" ]; then
  exit 0
fi

APPROVAL_RESULT=$(node "$SCAN" --query=approval-of "$VERDICT_HASH" --transcript="$transcript" 2>/dev/null)
APPROVED=$(echo "$APPROVAL_RESULT" | jq -r '.approved // false' 2>/dev/null)

if [ "$APPROVED" != "true" ]; then
  echo "🛑 BLOCKED: a passing visual-qa verdict exists (overallPass=$OVERALL_PASS) but the user has not yet approved it. Show the user the visual, then wait for their reply. ANY plain affirmative in their next message clears the gate — \"ship it\", \"ship all four\", \"looks good\", \"yes\", \"send them\", \"go\", etc. NEVER ask the user to type, copy, or paste a hash/token/APPROVED: string — that is not their job and is the exact friction we removed. Other bypasses (you, not the user): \"ship immediately for: <reason>\" | NO-VERIFY: <reason>." >&2
  exit 2
fi

# All checks passed — record this approval to the CANONICAL ledger so merging
# the worktree branch into main later doesn't force a re-run. Uses HEAD of
# SESSION_ROOT (the branch/commit that was actually approved).
HEAD_SHA=$(cd "$SESSION_ROOT" && git rev-parse HEAD 2>/dev/null)
if [ -n "$HEAD_SHA" ]; then
  node "$CANONICAL_ROOT/scripts/lib/visual-qa-ledger.mjs" --query=record \
    --repo="$CANONICAL_ROOT" --branch="$BRANCH" --commit="$HEAD_SHA" \
    --hash="$VERDICT_HASH" --session="$session_id" >/dev/null 2>&1 || true
fi

if [ "$OVERALL_PASS" != "true" ]; then
  echo "[visual-qa] verdict.overallPass=false but the user explicitly approved this push. Push allowed." >&2
fi
exit 0
