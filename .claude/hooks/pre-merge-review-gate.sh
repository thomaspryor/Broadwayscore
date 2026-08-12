#!/usr/bin/env bash
# pre-merge-review-gate.sh — PreToolUse hook on Bash. The merge-boundary review
# gate (task #1304, owner-approved 2026-08-12).
#
# Problem: pre-push-review-gate.sh guards the PUSH, which is one step too late.
# The documented worktree flow is `worktree → merge the branch into the SHARED
# local main checkout → push`, and ~20 parallel sessions share the one checkout
# at /Users/tompryor/Broadwayscore. So when the push gate blocks, the unreviewed
# merge commit is ALREADY on shared local main, and the next session to run
# push-with-retry.sh pushes `main` wholesale and carries it to origin. Observed
# 3× in one session on 2026-08-12: two commits reached origin/main while the
# authoring session's own push was still blocked. The dangerous state is created
# by the MERGE, so the gate belongs there too.
#
# SCOPE — deliberately narrow, and the narrowness is the design:
#   * gates `git merge <ref>` whose DESTINATION is main (the current branch, or
#     the branch a `git checkout main &&` earlier in the same command selects)
#   * gates `scripts/merge-worktree-to-main.sh [branch]` — the real call site
#     (:203). Its command string contains no `git merge` token and matches no
#     PUSH_INGRESS_RE pattern (the name has no "push" in it), so today it reaches
#     shared main completely ungated.
#   * DEFERS (exit 0) whenever the command also carries a push ingress.
#     pre-push-review-gate.sh:187-211 already awk-parses the merge source out of
#     `git merge X && git push origin main` and gates on the identical
#     queryPushAllowed. Letting both gates fire on one command is not merely
#     redundant — queryOverrideActiveForPush's consume marker is one-shot per
#     (sessionId, markerNs), so whichever gate consumed it first would starve
#     the other into blocking a merge the user had explicitly overridden. That
#     is a FALSE BLOCK on the primary documented flow, which is strictly worse
#     than a missed block: it wedges every session sharing the checkout.
#   * never touches `git pull`, `git merge --abort/--continue/--quit`, or merges
#     into any branch other than main.
#
# Decision logic lives in scripts/lib/review-gate.mjs --query=merge-gate
# (testable); transcript scanning in scripts/lib/transcript-scan.mjs. Escape
# hatches are byte-identical to the push gate's: `NO-SHIP-CHECK: <reason ≥15
# chars>` (in-command comment or in-flight assistant turn), the user's "ship
# immediately for: <reason>" (own marker namespace, `merge-gate`), and
# REVIEW_GATE_DISABLE=1. Fail-open on ANY infrastructure error — a wedged merge
# blocks every session's only integration path.

# Self-skip preamble (project copy only): if the user-level master exists, it is
# the registered one on local CLI — let it fire and exit here. On cloud
# sandboxes ~/.claude/hooks/ doesn't exist, so this project copy runs.
if [ -f "$HOME/.claude/hooks/pre-merge-review-gate.sh" ] && \
   [ "${BASH_SOURCE[0]}" != "$HOME/.claude/hooks/pre-merge-review-gate.sh" ]; then
  exit 0
fi

[ "${REVIEW_GATE_DISABLE:-0}" = "1" ] && exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
transcript=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
tool_use_id=$(echo "$input" | jq -r '.tool_use_id // empty' 2>/dev/null)

[ -z "$command" ] && exit 0

# Cheap pre-filter before any process spawn: no `merge` token, nothing to do.
# (The wrapper script's own name contains "merge", so it is covered too.)
case "$command" in
  *merge*) ;;
  *) exit 0 ;;
esac

# No transcript → we can't offer the NO-SHIP-CHECK escape hatch; fail open
# rather than wedge (matches pre-push-review-gate.sh:51-54).
[ -z "$transcript" ] && exit 0
[ ! -f "$transcript" ] && exit 0

# `git -C <path> merge` — resolve the -C target FIRST: the session cwd may not
# be a git repo at all when -C carries the real target.
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
# Canonical copies, so a worktree branch can't shadow the gate's own logic.
SCAN="$CANONICAL_ROOT/scripts/lib/transcript-scan.mjs"
GATE="$CANONICAL_ROOT/scripts/lib/review-gate.mjs"
[ ! -f "$SCAN" ] && exit 0
[ ! -f "$GATE" ] && exit 0

# ── Defer to the push gate on compound merge+push (see SCOPE above) ──────────
# Reuses the canonical push-ingress definition rather than a second regex, so
# the two gates cannot disagree about which one owns a given command.
PUSH_RESULT=$(node "$SCAN" --query=push-ingress --command="$command" 2>/dev/null)
IS_PUSH=$(echo "$PUSH_RESULT" | jq -r '.isPush // false' 2>/dev/null)
[ "$IS_PUSH" = "true" ] && exit 0

# ── Cross-repo guards (same shape as pre-push-review-gate.sh:97-130) ─────────
# `(` in the prefix class: `(cd repo && git merge x)` subshells must hit the
# guard too.
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
# -C target resolved above; route evaluation there (same repo family) or skip
# entirely (different repo — e.g. the review-texts/core-data repos, which merge
# constantly and are none of this gate's business).
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

# ── Decide ──────────────────────────────────────────────────────────────────
RESULT=$(node "$GATE" --query=merge-gate --repo="$EVAL_ROOT" --ledger-root="$CANONICAL_ROOT" --command="$command" 2>/dev/null)
[ -z "$RESULT" ] && exit 0                       # lib error — fail open
# `.allowed | tostring`, NOT `.allowed // empty`: jq's `//` treats `false` as
# ABSENT, so the alternative-operator form collapsed every genuine block into
# the empty string and the gate failed open 100% of the time. Caught by the
# acceptance harness on 2026-08-12 — the gate looked installed and healthy and
# blocked nothing. `tostring` yields "false"/"true"/"null", so a missing or
# unparseable field lands on "null" and still fails open, deliberately.
ALLOWED=$(echo "$RESULT" | jq -r '.allowed | tostring' 2>/dev/null)
[ "$ALLOWED" != "false" ] && exit 0

log_bypass() {
  mkdir -p "$HOME/.claude/logs" 2>/dev/null
  printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$1" "$transcript" "$2" \
    >> "$HOME/.claude/logs/finish-line-bypass.log" 2>/dev/null
}

# NO-SHIP-CHECK override in the gated command itself, as a shell comment:
#   git merge my-branch  # NO-SHIP-CHECK: <reason ≥15 chars>
# Needed because assistant text blocks are flushed to the transcript AFTER
# PreToolUse fires — and blocked-tool turns' text can be dropped entirely — so
# the transcript scan below can never see an in-flight NO-SHIP-CHECK. The
# command string is the one channel guaranteed visible at gate time. Anchored to
# a `#` preceded by whitespace/line-start, byte-identical to the
# pre-push-review-gate.sh precedent.
_NSC_MATCH=$(printf '%s' "$command" | grep -oE '(^|[[:space:]])#[[:space:]]*NO-SHIP-CHECK:[[:space:]]+.{15,}' | head -1)
if [ -n "$_NSC_MATCH" ]; then
  log_bypass "NO-SHIP-CHECK-MERGE-CMD" "$_NSC_MATCH"
  exit 0
fi

# NO-SHIP-CHECK: <reason ≥15 chars> in the in-flight assistant turn.
SCAN_ARGS=(--query=bypass-token --token=NO-SHIP-CHECK --transcript="$transcript")
[ -n "$tool_use_id" ] && SCAN_ARGS+=(--tool-use-id="$tool_use_id")
BYPASS_RESULT=$(node "$SCAN" "${SCAN_ARGS[@]}" 2>/dev/null)
HAS_BYPASS=$(echo "$BYPASS_RESULT" | jq -r '.hasBypass // false' 2>/dev/null)
if [ "$HAS_BYPASS" = "true" ]; then
  log_bypass "NO-SHIP-CHECK-MERGE" "$(echo "$BYPASS_RESULT" | jq -r '.line // empty' 2>/dev/null)"
  exit 0
fi

# User override "ship immediately for: <reason>". Own marker namespace so the
# push gate's and the visual gate's consumption of the same phrase cannot
# starve this gate (and vice versa) — see SCOPE above.
OVERRIDE_RESULT=$(node "$SCAN" --query=override-active-for-push --transcript="$transcript" --session-id="$session_id" --marker-ns=merge-gate --consume=true 2>/dev/null)
OVERRIDE_OK=$(echo "$OVERRIDE_RESULT" | jq -r '.override // false' 2>/dev/null)
if [ "$OVERRIDE_OK" = "true" ]; then
  log_bypass "SHIP-IMMEDIATELY-MERGE-GATE" "$session_id"
  exit 0
fi

REF=$(echo "$RESULT" | jq -r '.blockingRef // "?"' 2>/dev/null)
GATED_LINES=$(echo "$RESULT" | jq -r '.gatedLines // "?"' 2>/dev/null)
REASON=$(echo "$RESULT" | jq -r '.reason // "no review verdict"' 2>/dev/null)
FILES=$(echo "$RESULT" | jq -r '(.gatedFiles // [])[:5] | join(" ")' 2>/dev/null)
echo "🛑 BLOCKED: merging '$REF' into main would put $GATED_LINES unreviewed code lines on the SHARED local main checkout ($REASON). Files: $FILES. This fires on the MERGE, not the push, because ~20 sessions share this checkout — once the merge lands, any other session's push carries it to origin whether or not your own push is blocked. Run /ship-check (or /second-opinion for small diffs) NOW, fix findings, then merge; the skill records the verdict automatically. Docs/data-only or pure-revert merges may bypass with \`# NO-SHIP-CHECK: <specific reason ≥15 chars>\` appended to the command (logged and audited)." >&2
exit 2
