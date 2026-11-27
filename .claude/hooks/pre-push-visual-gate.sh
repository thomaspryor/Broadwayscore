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
# BRO-6136: resolve every operation's directory, including successive cds
# and generated shell scripts. Only exempt commands whose targets ALL belong
# to other repo families; unknown contexts keep the gate in scope.
_REPO_TARGET=$(node "$CANONICAL_ROOT/scripts/lib/command-repo.mjs" \
  --command="$command" --cwd="$PWD" --canonical-root="$CANONICAL_ROOT" \
  --operation=push 2>/dev/null)
[ "$(printf '%s' "$_REPO_TARGET" | jq -r '.outOfScope // false' 2>/dev/null)" = "true" ] && exit 0
EVAL_ROOT=$(printf '%s' "$_REPO_TARGET" | jq -r '.evalRoot // empty' 2>/dev/null)
[ -z "$EVAL_ROOT" ] && EVAL_ROOT="$SESSION_ROOT"
SESSION_ROOT="$EVAL_ROOT"

# BRO-6241: the visual-approval flow parks UI work on visual-hold/* and its
# screenshots on visual-evidence/* (scripts/visual-approval.js). Those refs never
# land by themselves (a CI lander ships them only after a signed owner approval),
# so a push whose ONLY target is one of them is not a ship. One plain
# `git push [flags] origin <src>:refs/heads/visual-(hold|evidence)/<name>`:
# no chaining, no substitution, so it cannot smuggle a second push past the gate.
_HOLD_RE='^[[:space:]]*git push( (-u|--force|--force-with-lease|--no-verify))* origin [A-Za-z0-9._/-]+:refs/heads/visual-(hold|evidence)/[A-Za-z0-9._-]+[[:space:]]*$'
if [[ "$command" =~ $_HOLD_RE ]] && [[ "$command" != *$'\n'* ]]; then
  exit 0
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
# task #879: a plain `origin/main...$DIFF_REF` diff has the same shared-
# checkout diff-scoping bug task #828 fixed for the review gate — with ~20
# parallel worktree sessions sharing one local main, that range includes
# every OTHER session's already-merged-but-unpushed commits, not just this
# push's own. Route through review-gate.mjs's own-merge-scoped changed-files
# query (shared with pre-push-review-gate.sh's diff-hash/push-allowed) so a
# pure backend/data push doesn't get falsely flagged as "UI files changed"
# by an unrelated .tsx/.css commit sitting on shared local main.
UI_PATTERN='^(src/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.)'
GATE_LIB="$CANONICAL_ROOT/scripts/lib/review-gate.mjs"
_UNSCOPED_UI_DIFF() {
  cd "$SESSION_ROOT" && git diff --name-only "origin/main...$DIFF_REF" 2>/dev/null | grep -E "$UI_PATTERN"
}
if [ -f "$GATE_LIB" ]; then
  CHANGED_RESULT=$(node "$GATE_LIB" --query=changed-files --repo="$SESSION_ROOT" --ref="$DIFF_REF" --pattern="$UI_PATTERN" 2>/dev/null)
  # Only trust a well-formed {files:[...]} response with no error — a query
  # this hook doesn't recognize (stale review-gate.mjs), a resolveBase
  # failure, or a node crash all print no valid `.files` array, and jq's
  # `.files[]? // empty` would otherwise silently read that as "no UI files"
  # (push allowed) instead of falling back to the safer unscoped diff below.
  if echo "$CHANGED_RESULT" | jq -e 'has("files") and (has("error") | not)' >/dev/null 2>&1; then
    UI_FILES_CHANGED=$(echo "$CHANGED_RESULT" | jq -r '.files[]? // empty' 2>/dev/null)
  else
    UI_FILES_CHANGED=$(_UNSCOPED_UI_DIFF)
  fi
else
  # Checkout without review-gate.mjs (e.g. a pre-#828 worktree branch or a
  # partial copy) — fall back to the old unscoped diff rather than fail closed.
  UI_FILES_CHANGED=$(_UNSCOPED_UI_DIFF)
fi
UI_FILES_ALL=$(printf '%s\n' "$UI_FILES_CHANGED" | sed '/^$/d' | sort -u)  # BRO-8156: full list, before any filter, for the ledger record
# BRO-5844: drop code files whose diff only changes copy (logic in the helper,
# canonical root ONLY so a pushed branch can't supply its own). Fail closed: any
# helper/git error keeps the full list.
_TOL="$CANONICAL_ROOT/scripts/lib/visual-text-only-diff.js"
if [ -n "$UI_FILES_CHANGED" ] && [ -f "$_TOL" ]; then
  _KEPT=$(printf '%s\n' "$UI_FILES_CHANGED" | (cd "$SESSION_ROOT" && node "$_TOL" --filter "origin/main...$DIFF_REF" 2>/dev/null)) && UI_FILES_CHANGED="$_KEPT"
fi
# BRO-7849: then drop .tsx/.jsx files whose diff provably cannot change a pixel (type-only, added .ts imports, analytics
# guards inside useEffect). Same rules: canonical root copy only (a branch cannot ship its own detector), fail closed
# (any error, timeout or missing typescript keeps the full list), every exemption logged to visual-gate-bypass.log.
_RIL="$CANONICAL_ROOT/scripts/lib/visual-render-impact.js"
_RIL_DETECTOR_LINE=""
if [ -n "$UI_FILES_CHANGED" ] && [ -f "$_RIL" ] && command -v timeout >/dev/null 2>&1; then
  _logdir="${CLAUDE_LOG_DIR:-$HOME/.claude/logs}"
  _BEFORE="$UI_FILES_CHANGED"
  _KEPT=$(printf '%s\n' "$UI_FILES_CHANGED" | (cd "$SESSION_ROOT" && CLAUDE_LOG_DIR="$_logdir" timeout 20 node "$_RIL" --filter "origin/main...$DIFF_REF" 2>/dev/null)) && UI_FILES_CHANGED="$_KEPT"
  if [ "$_BEFORE" != "$UI_FILES_CHANGED" ]; then
    _RIL_DETECTOR_LINE="render-impact detector: $(( $(printf '%s\n' "$_BEFORE" | sed '/^$/d' | wc -l) - $(printf '%s\n' "$UI_FILES_CHANGED" | sed '/^$/d' | wc -l) )) file(s) exempt as non-rendering; the rest render."
  else
    _RIL_DETECTOR_LINE="render-impact detector: no file exempt (each changes JSX, styles, state or non-effect code)."
  fi
fi
UI_FILES_GATED=$(printf '%s\n' "$UI_FILES_CHANGED" | sed '/^$/d' | sort -u)  # BRO-8156: full filtered list (scope check); the head -5 below is display only
UI_FILES_CHANGED=$(printf '%s\n' "$UI_FILES_CHANGED" | sed '/^$/d' | head -5)
if [ -z "$UI_FILES_CHANGED" ]; then
  # No UI files changed (or only copy edits) in this branch — push freely.
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
  printf '%s\tNO-VERIFY-in-command\t%s\n' "$(date +%s)" "${_NV_MATCH:0:160}" >> "$_logdir/visual-gate-bypass.log" 2>/dev/null; _TO=""; command -v timeout >/dev/null 2>&1 && _TO="timeout 10"; $_TO node "$SCAN" --query=owner-no-verify --transcript="$transcript" --advisory-log="$_logdir/visual-gate-bypass.log" --note="${_NV_MATCH:0:160}" >/dev/null 2>&1  # BRO-7850 advisory: logs would-block row, never blocks
  exit 0
fi

# >>> BRO-7298 small-fix lane (owner option A, 2026-11-10; the replay test strips this block to prove the red case)
# An owner-asked small UI fix ships without the yes: ONE plain `git push ... origin <src>[:<dst>]  # SMALL-FIX: page=<prod url>
# owner="<their exact words>"`. All rules live in the canonical copy of scripts/lib/visual-small-fix.mjs (a branch cannot loosen
# them); it records the screenshot debt the Stop check (top of verify-edits.sh) enforces. Never records/mints approvals. Fails closed. Kill VISUAL_SMALL_FIX_DISABLED=1.
_SMALL="$CANONICAL_ROOT/scripts/lib/visual-small-fix.mjs"
_SMALL_REFUSED=""
if [ "${VISUAL_SMALL_FIX_DISABLED:-0}" != "1" ] && [ -f "$_SMALL" ] && command -v timeout >/dev/null 2>&1 \
   && printf '%s' "$command" | grep -qE '(^|[[:space:]])#[[:space:]]*SMALL-FIX:'; then
  _SMALL_OUT=$(cd "$SESSION_ROOT" && timeout 20 node "$_SMALL" check --command="$command" --transcript="$transcript" \
    --repo="$SESSION_ROOT" --pattern="$UI_PATTERN" --session="$session_id" --project-dir="${CLAUDE_PROJECT_DIR:-$SESSION_ROOT}" 2>/dev/null)
  if [ "$(printf '%s' "$_SMALL_OUT" | jq -r '.allowed // false' 2>/dev/null)" = "true" ]; then
    echo "[visual-gate] small-fix lane: pushing without the pre-push yes. You now owe the owner a screenshot of $(printf '%s' "$_SMALL_OUT" | jq -r '.page' 2>/dev/null) once it is live (SendUserFile), before you close." >&2
    exit 0
  fi
  _SMALL_WHY=$(printf '%s' "$_SMALL_OUT" | jq -r '.reason // empty' 2>/dev/null)
  _SMALL_REFUSED="Small-fix lane refused: ${_SMALL_WHY:-the check timed out or crashed, so the normal gate applies}."
fi
_SMALL_LINE() { [ -n "$_SMALL_REFUSED" ] && { echo "$_SMALL_REFUSED"; return 0; }; [ "${VISUAL_SMALL_FIX_DISABLED:-0}" != "1" ] && [ -f "$_SMALL" ] && command -v timeout >/dev/null 2>&1 || return 0
  (cd "$SESSION_ROOT" && timeout 15 node "$_SMALL" explain --repo="$SESSION_ROOT" --range="origin/main...$DIFF_REF" --pattern="$UI_PATTERN" 2>/dev/null) || true; }
# <<< BRO-7298 small-fix lane

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

# Durable approval (BRO-7628): the same UI diff was already approved and marked on origin (survives a container
# restart and a test-only follow-up push). Any error means "not approved": the normal flow below decides.
_DUR="$CANONICAL_ROOT/scripts/lib/visual-approval-durable.js"
if [ -f "$_DUR" ] && command -v timeout >/dev/null 2>&1 && timeout 20 node "$_DUR" check --repo="$SESSION_ROOT" --ref="$DIFF_REF" >/dev/null 2>&1; then
  _logdir="${CLAUDE_LOG_DIR:-$HOME/.claude/logs}"; mkdir -p "$_logdir" 2>/dev/null
  printf '%s\tdurable-approval\t%s\n' "$(date +%s)" "$DIFF_REF" >> "$_logdir/visual-gate-bypass.log" 2>/dev/null
  exit 0
fi
# Mint the marker once this exact UI diff is approved (verdict.uiPatchId must equal the current id). Never on bypass paths.
_mint_durable() {
  [ -f "$_DUR" ] && command -v timeout >/dev/null 2>&1 || return 0
  local vid; vid=$(jq -r '.uiPatchId // empty' "$VERDICT_PATH" 2>/dev/null)
  [ -n "$vid" ] || return 0
  ( VISUAL_GATE_MINT=1 timeout 25 node "$_DUR" mint --repo="$SESSION_ROOT" --ref="$DIFF_REF" --verdict-id="$vid" >/dev/null 2>&1 & ) 2>/dev/null
}

# BRO-7849: one ordered checklist of everything this land still needs (scripts/land-ready.mjs, report-only), appended to
# every block message so the session fixes ALL of it in one pass and the owner is asked once. Errors print nothing.
_LAND_SUMMARY() {
  local f="$CANONICAL_ROOT/scripts/land-ready.mjs"
  [ -f "$f" ] && command -v timeout >/dev/null 2>&1 || return 0
  printf '%s\n' "--- land checklist (npm run land:ready for the full run) ---"
  (cd "$SESSION_ROOT" && LAND_READY_CWD="$SESSION_ROOT" timeout 60 node "$f" --hook 2>/dev/null) || true
}

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

_FIX="$CANONICAL_ROOT/scripts/lib/visual-design-diff.js"  # BRO-7888: canonical copy only
# One plain line telling the session who decides this push (fix-only: do not ask the owner; design: owner's yes).
_FIX_LINE() {
  [ -f "$_FIX" ] && command -v timeout >/dev/null 2>&1 || return 0
  [ "${VISUAL_FIX_SELF_CLEAR_DISABLED:-0}" = "1" ] && return 0
  (cd "$SESSION_ROOT" && timeout 30 node "$_FIX" --explain --range="origin/main...$DIFF_REF" ${1:+--verdict="$1"} 2>/dev/null) || true
}

if [ ! -f "$VERDICT_PATH" ]; then
  {
    echo "🛑 BLOCKED: push of UI changes without a visual-qa verdict (branch $BRANCH)."
    echo "UI files: $(echo "$UI_FILES_CHANGED" | tr '\n' ' ')"
    [ -n "$_RIL_DETECTOR_LINE" ] && echo "$_RIL_DETECTOR_LINE"
    _FIX_LINE
    _SMALL_LINE
    echo "Run /visual-qa (screenshots at 390 and 1440). Do NOT ask the owner until every item below is done; then send ONE message with the screenshots. Any clear yes after that message clears the gate."
    _LAND_SUMMARY
  } >&2
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

# BRO-7888 (owner decision 2026-11-20): a UI diff that changes no design (a logic fix or wording change, as
# scripts/lib/visual-design-diff.js classifies it) ships on the session's own passing, current visual-qa verdict with no
# owner yes. Any design file, or a mix of fix and design, still falls through to the owner approval below. Runs the CANONICAL
# ROOT copy only (a pushed branch cannot supply a looser classifier). Fail closed: a missing copy, timeout, crash or
# disabled switch means no self-clear. Kill switch VISUAL_FIX_SELF_CLEAR_DISABLED=1. Never mints a durable approval (those
# are owner-approved only). Every use is logged to visual-gate-bypass.log.
# >>> BRO-7888 self-clear (the replay test strips this block to prove the red case)
if [ "${VISUAL_FIX_SELF_CLEAR_DISABLED:-0}" != "1" ] && [ -f "$_FIX" ] && command -v timeout >/dev/null 2>&1; then
  if (cd "$SESSION_ROOT" && timeout 30 node "$_FIX" --self-clear --range="origin/main...$DIFF_REF" --verdict="$VERDICT_PATH" >/dev/null 2>&1); then
    _logdir="${CLAUDE_LOG_DIR:-$HOME/.claude/logs}"; mkdir -p "$_logdir" 2>/dev/null
    printf '%s\tfix-only-self-clear\t%s\n' "$(date +%s)" "$DIFF_REF $(printf '%s' "$UI_FILES_CHANGED" | tr '\n' ' ')" >> "$_logdir/visual-gate-bypass.log" 2>/dev/null
    exit 0
  fi
fi
# <<< BRO-7888 self-clear
# Ledger check — ALWAYS uses CANONICAL_ROOT so the shared ledger at
# .claude/visual-qa/approvals.jsonl is visible to both worktree sessions
# (when they record approvals) and main-repo sessions (when they push after
# merging a worktree branch). The contentHash match is rebase/squash-tolerant.
LEDGER_RESULT=$(node "$CANONICAL_ROOT/scripts/lib/visual-qa-ledger.mjs" --query=push-allowed --repo="$CANONICAL_ROOT" --current-content-hash="$VERDICT_HASH" 2>/dev/null)
LEDGER_OK=$(echo "$LEDGER_RESULT" | jq -r '.allowed // false' 2>/dev/null)
LEDGER_REASON=$(echo "$LEDGER_RESULT" | jq -r '.reason // empty' 2>/dev/null)
if [ "$LEDGER_OK" = "true" ]; then
  _mint_durable
  exit 0
fi

# >>> BRO-8156 scope reuse (the replay test strips this block to prove the red case)
# One owner yes per branch covers later revisions of the SAME UI files when the passing verdict shows the pushed
# content (visual-scope.js head-current) and a fresh ledger entry lists every gated file. Never records or mints.
_CURRENT=0
if [ "$OVERALL_PASS" = "true" ] && [ -n "$UI_FILES_GATED" ] \
   && node "$CANONICAL_ROOT/scripts/lib/visual-scope.js" head-current --cwd="$SESSION_ROOT" --ref="$DIFF_REF" --verdict="$VERDICT_PATH" --files="$(printf '%s' "$UI_FILES_GATED" | paste -sd, -)" 2>/dev/null; then
  _CURRENT=1
fi
if [ "$_CURRENT" = 1 ]; then
  _SCOPE=$(node "$CANONICAL_ROOT/scripts/lib/visual-qa-ledger.mjs" --query=scope-allowed --repo="$CANONICAL_ROOT" --branch="$BRANCH" --ui-files="$(printf '%s' "$UI_FILES_GATED" | paste -sd, -)" 2>/dev/null)
  if [ "$(printf '%s' "$_SCOPE" | jq -r '.allowed // false' 2>/dev/null)" = "true" ]; then
    _logdir="${CLAUDE_LOG_DIR:-$HOME/.claude/logs}"; mkdir -p "$_logdir" 2>/dev/null
    printf '%s\tscope-reuse\t%s\n' "$(date +%s)" "$BRANCH $(printf '%s' "$UI_FILES_GATED" | tr '\n' ' ')" >> "$_logdir/visual-gate-bypass.log" 2>/dev/null
    exit 0
  fi
fi
# BRO-7295 yes-after-screenshots bound; BRO-8156: from verdict.scopeFirstAt (first screenshots of this file set).
_AFTER_ARG="--after-file=$VERDICT_PATH"
_SFA=$(jq -r '.scopeFirstAt // empty' "$VERDICT_PATH" 2>/dev/null)
if [ "$_CURRENT" = 1 ] && [ -n "$_SFA" ] && jq -e --arg g "$UI_FILES_GATED" '(.uiFiles // null) as $u | $u != null and (($g | split("\n") | map(select(. != ""))) - $u | length == 0)' "$VERDICT_PATH" >/dev/null 2>&1; then
  _AFTER_ARG="--after=$_SFA"
fi
# <<< BRO-8156 scope reuse
APPROVAL_RESULT=$(node "$SCAN" --query=approval-of "$VERDICT_HASH" --transcript="$transcript" "$_AFTER_ARG" 2>/dev/null)  # BRO-7295: yes must be newer than the verdict
APPROVED=$(echo "$APPROVAL_RESULT" | jq -r '.approved // false' 2>/dev/null)

if [ "$APPROVED" != "true" ]; then
  # BRO-419: route ready-to-review evidence to the owner's Linear channel.
  # Notification success is not approval: every outcome still exits 2 below.
  node "$CANONICAL_ROOT/scripts/lib/linear-attach-approval.js" \
    --branch="$BRANCH" --repo="$SESSION_ROOT" --dir="$(dirname "$VERDICT_PATH")" \
    >/dev/null || true
  {
    echo "🛑 BLOCKED: a passing visual-qa verdict exists (overallPass=$OVERALL_PASS) but the owner has not approved it yet (branch $BRANCH)."
    echo "UI files: $(echo "$UI_FILES_CHANGED" | tr '\n' ' ')"
    [ -n "${_SCOPE:-}" ] && echo "Earlier owner yes on this branch: $(printf '%s' "$_SCOPE" | jq -r '.reason // empty' 2>/dev/null)"  # BRO-8156
    [ -n "$_RIL_DETECTOR_LINE" ] && echo "$_RIL_DETECTOR_LINE"
    _FIX_LINE "$VERDICT_PATH"
    _SMALL_LINE
    echo "Do NOT ask the owner until every item below is done; then send ONE message with the screenshots. Any clear yes after that message clears the gate (\"ship it\", \"looks good\", \"yes\", \"go\", ...): the reader (transcript-scan.mjs, BRO-7848) accepts all of them. NEVER ask the owner to type, copy or paste a hash/token/APPROVED: string. Other bypasses (you, not the owner): \"ship immediately for: <reason>\" | NO-VERIFY: <reason>."
    _LAND_SUMMARY
  } >&2
  exit 2
fi

# All checks passed — record this approval to the CANONICAL ledger so merging
# the worktree branch into main later doesn't force a re-run. Uses HEAD of
# SESSION_ROOT (the branch/commit that was actually approved).
HEAD_SHA=$(cd "$SESSION_ROOT" && git rev-parse HEAD 2>/dev/null)
if [ -n "$HEAD_SHA" ]; then
  node "$CANONICAL_ROOT/scripts/lib/visual-qa-ledger.mjs" --query=record \
    --repo="$CANONICAL_ROOT" --branch="$BRANCH" --commit="$HEAD_SHA" \
    --hash="$VERDICT_HASH" --session="$session_id" \
    --ui-files="$(jq -r --arg a "$UI_FILES_ALL" '($a | split("\n") | map(select(. != ""))) as $all | if (.uiFiles | type) == "array" then [$all[] | select(. as $f | $u_files | index($f))] else [] end | join(",")' --argjson u_files "$(jq -c '.uiFiles // []' "$VERDICT_PATH" 2>/dev/null || echo '[]')" "$VERDICT_PATH" 2>/dev/null)" \
    >/dev/null 2>&1 || true  # BRO-8156: only files the owner's screenshots covered (verdict.uiFiles) join the approved scope
fi

_mint_durable
if [ "$OVERALL_PASS" != "true" ]; then
  echo "[visual-qa] verdict.overallPass=false but the user explicitly approved this push. Push allowed." >&2
fi
exit 0
