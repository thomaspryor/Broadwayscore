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
# Scope: pushes whose DESTINATION is main (that's the threat model — unreviewed
# code landing on the prod trunk; Vercel deploys main HEAD). WIP branch backup
# pushes ("push every ~30 min") flow freely. Blocks when:
#   - the main-bound gated diff (src/, scripts/, .github/workflows/ code files
#     vs origin/main) exceeds the line budget (30) AND
#   - no fresh pass verdict exists in .claude/review-verdicts.jsonl
#     (written by /ship-check, /code-review, /second-opinion via
#     scripts/lib/review-gate.mjs --query=record) AND
#   - no `NO-SHIP-CHECK: <reason ≥15 chars>` in the in-flight assistant turn
#     (transcript scan) OR as a `# NO-SHIP-CHECK: <reason>` shell comment in
#     the gated command itself (2026-07-20, card #233: the transcript scan
#     alone can never see in-flight text — see the in-command check below) AND
#   - no user "ship immediately for: <reason>" override (review-gate namespace)
#
# Compound commands (ship-check round 3 P0-1): `git merge X && git push origin
# main` / `git commit … && git push` are evaluated on what WILL be pushed —
# the merge source ref / the working tree — not just the pre-merge branch tip.
#
# Decision logic lives in scripts/lib/review-gate.mjs (testable); transcript
# scanning in scripts/lib/transcript-scan.mjs. Emergency disable:
# REVIEW_GATE_DISABLE=1. Fail-open on any infrastructure error — this gate
# must never wedge an unrelated push.
#
# Also blocks (independently, see the "CI-red claim conflict" section below,
# task #584) a push whose gated diff matches another in_progress task's
# `scripts/claim-ci-red.js claim` — the double-fix collision task #542 was
# built to catch, now actually enforced instead of manual-only.

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
# No transcript → we can't offer the NO-SHIP-CHECK escape hatch; fail open
# rather than wedge (matches pre-push-visual-gate.sh).
[ -z "$transcript" ] && exit 0
[ ! -f "$transcript" ] && exit 0

# `git -C <path> push` (ship-check round 3 P0-2): resolve the -C target FIRST —
# the session cwd may not be a git repo at all when -C carries the real target.
_GIT_C=$(printf '%s' "$command" | grep -oE 'git[[:space:]]+-C[[:space:]]+[^[:space:];&|)]+' | head -1 | awk '{print $3}')
GIT_C_REPO=""
if [ -n "$_GIT_C" ]; then
  case "$_GIT_C" in
    ~/*)  _GIT_C="$HOME/${_GIT_C#~/}" ;;
    ~)    _GIT_C="$HOME" ;;
  esac
  [ -d "$_GIT_C" ] && GIT_C_REPO=$(git -C "$_GIT_C" rev-parse --show-toplevel 2>/dev/null)
fi

# SESSION_ROOT: git root of the CWD (may be a linked worktree); falls back to
# the -C target when the cwd isn't a repo.
SESSION_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$SESSION_ROOT" ] && SESSION_ROOT="$GIT_C_REPO"
[ -z "$SESSION_ROOT" ] && exit 0

# CANONICAL_ROOT: the main-worktree root (shared ledger + canonical libs).
_GIT_COMMON=$(git -C "$SESSION_ROOT" rev-parse --git-common-dir 2>/dev/null)
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

# Cross-repo push guards. `(` in the prefix class: `(cd repo && git push)`
# subshells must hit the guard too (ship-check round 3 P1-8).
_FIRST_CD=$(printf '%s' "$command" | grep -oE '(^|[[:space:];&|(])cd[[:space:]]+[^[:space:];&|<>)]+' | head -1 | sed 's/^[[:space:];&|(]*cd[[:space:]]*//')
EVAL_ROOT="$SESSION_ROOT"
if [ -n "$_FIRST_CD" ]; then
  case "$_FIRST_CD" in
    ~/*)  _FIRST_CD="$HOME/${_FIRST_CD#~/}" ;;
    ~)    _FIRST_CD="$HOME" ;;
  esac
  if [ -d "$_FIRST_CD" ]; then
    _CD_REPO=$(git -C "$_FIRST_CD" rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$_CD_REPO" ]; then
      if [ "$_CD_REPO" != "$CANONICAL_ROOT" ] && [ "$_CD_REPO" != "$SESSION_ROOT" ]; then
        _CD_CANON=$(cd "$_CD_REPO" && dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null)
        [ "$_CD_CANON" != "$CANONICAL_ROOT" ] && exit 0  # different repo — not our gate
      fi
      EVAL_ROOT="$_CD_REPO"  # same repo family: evaluate where the command runs
    fi
  fi
fi
# -C target resolved above; route evaluation there (same repo family) or
# skip entirely (different repo — not our gate).
if [ -n "$GIT_C_REPO" ]; then
  _C_COMMON=$(git -C "$GIT_C_REPO" rev-parse --git-common-dir 2>/dev/null)
  case "$_C_COMMON" in
    /*) _C_CANON=$(dirname "$_C_COMMON") ;;
    *)  _C_CANON="$GIT_C_REPO" ;;
  esac
  if [ "$_C_CANON" = "$CANONICAL_ROOT" ]; then
    EVAL_ROOT="$GIT_C_REPO"
  else
    exit 0
  fi
fi

# ── What is being pushed, and is any of it bound for main? ──────────────────
# Tokenize after `push`: skip flags (and the value of value-taking flags like
# -o/--push-option), stop at a command separator; first bare token is the
# remote, the rest are refspecs (ship-check round 3 P0-3: `src:dst` gated the
# wrong ref; P2: `-o ci.skip` ate the remote slot).
REFSPECS=$(printf '%s' "$command" | awk '
{
  in_push=0; skipped_remote=0; skipnext=0
  for(i=1;i<=NF;i++){
    raw=$i
    if(in_push && raw ~ /^[;&|]+$/) exit         # && ; || — push cmd ended
    tok=raw
    gsub(/^[;&|(]+/, "", tok)
    if(tok=="push" && !in_push) { in_push=1; continue }
    if(!in_push) continue
    if(skipnext) { skipnext=0; continue }
    if(tok=="-o" || tok=="--push-option") { skipnext=1; continue }
    if(tok~/^-/) continue
    if(tok=="") continue
    if(!skipped_remote) { skipped_remote=1; continue }
    print tok
  }
}')

CANDIDATES=""
CUR_BRANCH=$(git -C "$EVAL_ROOT" branch --show-current 2>/dev/null)
if [ -z "$REFSPECS" ]; then
  # Bare `git push` / wrapper script / gh pr merge: destination is the current
  # branch's upstream. Only gate when that's main.
  [ "$CUR_BRANCH" != "main" ] && exit 0
  CANDIDATES="HEAD"
else
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    spec="${spec#+}"                    # +src:dst force form
    case "$spec" in
      *:*) src="${spec%%:*}"; dst="${spec#*:}" ;;
      *)   src="$spec";       dst="$spec" ;;
    esac
    [ -z "$src" ] && continue           # `:branch` deletion — pushes nothing
    case "${dst##*/}" in main) ;; *) continue ;; esac
    if [ "$src" != "HEAD" ] && ! git -C "$EVAL_ROOT" rev-parse --verify --quiet "$src^{commit}" >/dev/null 2>&1; then
      src="HEAD"                        # unresolvable src — gate conservatively on HEAD
    fi
    CANDIDATES="$CANDIDATES $src"
  done <<EOF
$REFSPECS
EOF
  [ -z "${CANDIDATES// /}" ] && exit 0  # explicit refspecs, none bound for main
fi

# Compound-command candidates (round 3 P0-1): the pushed state may not exist as
# a commit yet at hook time.
#   `git merge <ref> … && git push origin main` → evaluate the merge source(s)
#   `git commit … && git push`                 → evaluate the working tree
if printf '%s' "$command" | grep -qE '(^|[[:space:];&|(])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+merge[[:space:]]'; then
  MERGE_TOKENS=$(printf '%s' "$command" | awk '
  {
    in_merge=0
    for(i=1;i<=NF;i++){
      raw=$i
      if(in_merge && raw ~ /^[;&|]+$/) { in_merge=0; continue }
      tok=raw
      gsub(/^[;&|(]+/, "", tok)
      if(tok=="merge") { in_merge=1; continue }
      if(!in_merge) continue
      if(tok~/^-/) continue
      gsub(/["'"'"']/, "", tok)
      if(tok!="") print tok
    }
  }')
  while IFS= read -r mt; do
    [ -z "$mt" ] && continue
    if git -C "$EVAL_ROOT" rev-parse --verify --quiet "$mt^{commit}" >/dev/null 2>&1; then
      CANDIDATES="$CANDIDATES $mt"
    fi
  done <<EOF
$MERGE_TOKENS
EOF
fi
if printf '%s' "$command" | grep -qE '(^|[[:space:];&|(])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+commit'; then
  CANDIDATES="$CANDIDATES WORKTREE"
fi

# ── CI-red claim conflict (task #584, closing the gap task #542 left open). ─
# Independent of the review-verdict gate below — its own check, its own exit
# path — so this can't regress the existing gate. Runs regardless of the
# gated-line budget: a duplicate-fix collision (the shouldShowSentiment
# double-declare incident) can be a one-line change. Blocks when this push's
# gated-file content matches a symbol/runId another in_progress task claimed
# via `node scripts/claim-ci-red.js claim`. Self-exempt with an inline
# `# CI-RED-TASK: <taskId>` comment on the push command (same convention as
# NO-SHIP-CHECK above) — without it, the session that owns the claim would
# block its own fix. `tail -1` (not `head -1`, adversarial review task #584):
# a marker appended at the END of the command — the conventional place for an
# inline comment — must win over an earlier incidental match (e.g. inside an
# echoed usage string or heredoc body earlier in the same command).
# Emergency escape hatch for a false positive: CI_RED_CLAIM_DISABLE=1 (mirrors
# REVIEW_GATE_DISABLE / ENTERWORKTREE_GUARD_DISABLE conventions in this repo)
# — deliberately NOT the NO-SHIP-CHECK bypass, since that's meant to skip
# "no review yet", not silence a real duplicate-fix collision.
[ "${CI_RED_CLAIM_DISABLE:-0}" = "1" ] && CI_RED_SKIP=1 || CI_RED_SKIP=0
CI_RED_OWN_TASK=$(printf '%s' "$command" | grep -oE '(^|[[:space:]])#[[:space:]]*CI-RED-TASK:[[:space:]]+[0-9]+' | grep -oE '[0-9]+$' | tail -1)
CI_RED_BLOCK=""
if [ "$CI_RED_SKIP" != "1" ]; then
  for ref in $CANDIDATES; do
    CRC_ARGS=(--query=ci-red-claim-conflict --repo="$EVAL_ROOT" --ref="$ref")
    [ -n "$CI_RED_OWN_TASK" ] && CRC_ARGS+=(--own-task="$CI_RED_OWN_TASK")
    CRC_RESULT=$(node "$GATE" "${CRC_ARGS[@]}" 2>/dev/null)
    [ -z "$CRC_RESULT" ] && continue        # lib error — fail open for this ref
    CRC_BLOCKED=$(echo "$CRC_RESULT" | jq -r '.blocked // false' 2>/dev/null)
    if [ "$CRC_BLOCKED" = "true" ]; then
      CI_RED_BLOCK="$CRC_RESULT"
      break
    fi
  done
fi
if [ -n "$CI_RED_BLOCK" ]; then
  CRC_REASON=$(echo "$CI_RED_BLOCK" | jq -r '.reason // "another task already claims this CI red"' 2>/dev/null)
  echo "🛑 BLOCKED: push conflicts with an active CI-red claim — $CRC_REASON. If this is YOUR OWN claimed fix, append \` # CI-RED-TASK: <your task id>\` to the push command (claim it first: node scripts/claim-ci-red.js claim --task <id> --symbol <name>). Otherwise coordinate with that task before pushing — this is the exact double-fix collision task #542/#584 exist to prevent. False positive? Emergency override: CI_RED_CLAIM_DISABLE=1 (logged nowhere yet — use sparingly, prefer the CI-RED-TASK marker)." >&2
  exit 2
fi

# ── Evaluate every candidate; the strictest verdict wins. ───────────────────
BLOCK_RESULT=""
for ref in $CANDIDATES; do
  RESULT=$(node "$GATE" --query=push-allowed --repo="$EVAL_ROOT" --ledger-root="$CANONICAL_ROOT" --ref="$ref" 2>/dev/null)
  [ -z "$RESULT" ] && continue          # lib error — fail open for this ref
  ALLOWED=$(echo "$RESULT" | jq -r '.allowed // false' 2>/dev/null)
  if [ "$ALLOWED" != "true" ]; then
    BLOCK_RESULT="$RESULT"
    break
  fi
done
[ -z "$BLOCK_RESULT" ] && exit 0

log_bypass() {
  mkdir -p "$HOME/.claude/logs" 2>/dev/null
  printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$1" "$transcript" "$2" \
    >> "$HOME/.claude/logs/finish-line-bypass.log" 2>/dev/null
}

# NO-SHIP-CHECK override in the gated command itself, as a shell comment:
#   git push ...  # NO-SHIP-CHECK: <reason ≥15 chars>
# Needed because assistant text blocks are flushed to the transcript AFTER
# PreToolUse fires — and blocked-tool turns' text can be dropped entirely —
# so the bypass-token transcript scan below can never see an in-flight
# NO-SHIP-CHECK (same structural gap found + fixed in pre-push-visual-gate.sh
# 2026-07-20, session e1dca052; Notion 39c637c5 audit card #233). The command
# string is the one channel guaranteed visible at gate time. Anchored to a
# `#` preceded by whitespace/line-start (byte-identical to the
# pre-push-visual-gate.sh precedent) so a bare mid-string mention can't
# match — note this does NOT make it immune to a `#`-prefixed line inside a
# commit message or heredoc body in the same command; that's an accepted gap
# since this guards Claude's own discipline, not a hostile actor, and every
# use is logged. ≥15-char reason matches the queryBypassToken convention.
_NSC_MATCH=$(printf '%s' "$command" | grep -oE '(^|[[:space:]])#[[:space:]]*NO-SHIP-CHECK:[[:space:]]+.{15,}' | head -1)
if [ -n "$_NSC_MATCH" ]; then
  log_bypass "NO-SHIP-CHECK-CMD" "$_NSC_MATCH"
  exit 0
fi

# NO-SHIP-CHECK: <reason ≥15 chars> in the in-flight assistant turn.
[ -n "$transcript" ] && [ -f "$transcript" ] && {
  SCAN_ARGS=(--query=bypass-token --token=NO-SHIP-CHECK --transcript="$transcript")
  [ -n "$tool_use_id" ] && SCAN_ARGS+=(--tool-use-id="$tool_use_id")
  BYPASS_RESULT=$(node "$SCAN" "${SCAN_ARGS[@]}" 2>/dev/null)
  HAS_BYPASS=$(echo "$BYPASS_RESULT" | jq -r '.hasBypass // false' 2>/dev/null)
  if [ "$HAS_BYPASS" = "true" ]; then
    log_bypass "NO-SHIP-CHECK-PUSH" "$(echo "$BYPASS_RESULT" | jq -r '.line // empty' 2>/dev/null)"
    exit 0
  fi

  # User override "ship immediately for: <reason>" — own marker namespace so
  # the visual gate's consumption of the same phrase doesn't starve this gate.
  OVERRIDE_RESULT=$(node "$SCAN" --query=override-active-for-push --transcript="$transcript" --session-id="$session_id" --marker-ns=review-gate --consume=true 2>/dev/null)
  OVERRIDE_OK=$(echo "$OVERRIDE_RESULT" | jq -r '.override // false' 2>/dev/null)
  if [ "$OVERRIDE_OK" = "true" ]; then
    log_bypass "SHIP-IMMEDIATELY-REVIEW-GATE" "$session_id"
    exit 0
  fi
}

GATED_LINES=$(echo "$BLOCK_RESULT" | jq -r '.gatedLines // "?"' 2>/dev/null)
REASON=$(echo "$BLOCK_RESULT" | jq -r '.reason // "no review verdict"' 2>/dev/null)
FILES=$(echo "$BLOCK_RESULT" | jq -r '(.gatedFiles // [])[:5] | join(" ")' 2>/dev/null)
echo "🛑 BLOCKED: push to main of $GATED_LINES unreviewed code lines ($REASON). Files: $FILES. This gate fires on the push itself — no completion claim needed. Run /ship-check (or /second-opinion for small diffs) NOW, fix findings, then push; the skill records the verdict automatically. Docs/data-only or pure-revert pushes may bypass with a line starting \`NO-SHIP-CHECK: <specific reason ≥15 chars>\` (logged and audited)." >&2
exit 2
