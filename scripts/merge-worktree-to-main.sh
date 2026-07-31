#!/usr/bin/env bash
#
# merge-worktree-to-main.sh — safely integrate a worktree branch into main and push.
#
# WHY THIS EXISTS
#   `git pull --rebase` SILENTLY DROPS merge commits. Hand-rolled worktree
#   integration has therefore "pushed successfully" while the work was missing
#   from origin (2026-06-21 incident; memory/feedback_pull_rebase_drops_merge_commits.md).
#   This script encodes the only-safe sequence so no session improvises it again:
#     1. integrate origin with `git merge` (NEVER rebase),
#     2. merge the worktree branch (preserves the commits),
#     3. push with merge-based retry if origin moved,
#     4. VERIFY the changed files actually exist on origin/main, exit non-zero if not.
#   It also beats the background data-daemon that constantly rewrites
#   data/audit + cloud-memory + public/data/admin (which otherwise blocks merges).
#
# USAGE
#   scripts/merge-worktree-to-main.sh [branch] [-- file1 file2 ...]
#     branch   worktree branch to integrate (default: current branch)
#     files    paths that MUST exist on origin/main after push
#              (default: the files the branch changed vs main)
#   DRY_RUN=1 scripts/merge-worktree-to-main.sh   # do everything except the push
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/push-mutex.sh
source "$SCRIPT_DIR/lib/push-mutex.sh"

die() { push_mutex_release; echo "❌ $*" >&2; exit 1; }
log() { echo "→ $*"; }

# --- Parse args: optional branch, optional "-- files..." ---
BRANCH=""; VERIFY_FILES=()
if [ "${1:-}" = "--" ]; then shift; VERIFY_FILES=("$@");
else
  [ $# -gt 0 ] && { BRANCH="$1"; shift; }
  [ "${1:-}" = "--" ] && shift
  VERIFY_FILES=("$@")
fi

# --- Locate the main worktree (first entry of `git worktree list`) ---
MAIN_DIR=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
[ -n "$MAIN_DIR" ] && [ -d "$MAIN_DIR" ] || die "could not locate main worktree via 'git worktree list'"
g() { git -C "$MAIN_DIR" "$@"; }

DEFAULT_BRANCH=$(g symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=main

# --- Resolve branch to integrate ---
[ -z "$BRANCH" ] && BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -n "$BRANCH" ] || die "no branch given and could not detect current branch"
[ "$BRANCH" = "$DEFAULT_BRANCH" ] && die "branch '$BRANCH' is the default branch — nothing to integrate"
g rev-parse --verify "$BRANCH" >/dev/null 2>&1 || die "branch '$BRANCH' not found"

log "main worktree: $MAIN_DIR"
log "integrating branch: $BRANCH → $DEFAULT_BRANCH"

# --- Default the verify list to the branch's changed files ---
if [ ${#VERIFY_FILES[@]} -eq 0 ]; then
  MB=$(g merge-base "$DEFAULT_BRANCH" "$BRANCH" 2>/dev/null)
  if [ -n "$MB" ]; then
    while IFS= read -r f; do [ -n "$f" ] && VERIFY_FILES+=("$f"); done \
      < <(g diff --name-only "$MB" "$BRANCH" 2>/dev/null)
  fi
fi
log "will verify ${#VERIFY_FILES[@]} file(s) on origin after push"

# ── Local push mutex (task #556) ─────────────────────────────────────────────
# The whole flow below — stash, checkout main, fetch+merge origin, merge the
# worktree branch, push, verify — operates on the SHARED main worktree
# directory ($MAIN_DIR) and origin's ref. Two concurrent sessions running this
# script interleave on both, which is exactly the #546 incident class
# (concurrent session reset origin's tip between this script's push and its
# own verify step). Acquire before touching anything and release via the EXIT
# trap on every path, including die(). Fails OPEN on timeout: the existing
# ancestor-check verify step below remains as defense in depth. See
# scripts/lib/push-mutex.sh.
push_mutex_acquire
trap 'push_mutex_release' EXIT

# --- Stash any dirty tracked files (the data-daemon race) ---
STASHED=0
if ! g diff --quiet 2>/dev/null || ! g diff --cached --quiet 2>/dev/null; then
  log "working tree dirty (likely the data daemon) — stashing"
  g stash push -m "wt-integ-$$" >/dev/null 2>&1 && STASHED=1
fi

restore_stash() {
  [ "$STASHED" = 1 ] || return 0
  if ! g stash pop >/dev/null 2>&1; then
    # Conflicts are only ever in auto-generated state files — take the committed
    # version (the daemon regenerates them) and drop the stash. Discarding
    # cloud-memory/ is safe: it's a mirror of local memory, regenerated and
    # committed by session-stop's sync-memory-to-repo.sh --commit.
    log "stash pop conflicted on auto-gen files — taking committed version"
    g checkout HEAD -- cloud-memory/ data/audit/ public/data/admin/ >/dev/null 2>&1 || true
    g checkout HEAD -- . >/dev/null 2>&1 || true
    g stash drop >/dev/null 2>&1 || true
  fi
}

# --- Ensure main is checked out, then MERGE (never rebase) ---
g checkout "$DEFAULT_BRANCH" >/dev/null 2>&1 || { restore_stash; die "could not checkout $DEFAULT_BRANCH"; }

log "fetch + merge origin/$DEFAULT_BRANCH (no rebase)"
g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null || log "  ⚠ fetch failed (offline?) — continuing with cached ref"
# Diff base for the post-merge syntax floor below: origin's CURRENT tip, not
# local HEAD before this run. A prior invocation that died AFTER merging but
# BEFORE pushing (e.g. the syntax check below caught a collision) leaves the
# broken merge commit sitting in $MAIN_DIR — a naive "diff since local HEAD at
# script start" would then see NO new changes on retry (both merges become
# no-ops) and silently push the still-broken commit. Anchoring to origin's tip
# instead always answers the question that actually matters — "does what
# we're about to push differ from what's live, and does that diff parse" —
# regardless of how many retries it took to get here.
ORIGIN_BASE_SHA=$(g rev-parse "origin/$DEFAULT_BRANCH" 2>/dev/null || g rev-parse HEAD)
if ! g merge "origin/$DEFAULT_BRANCH" --no-edit >/dev/null 2>&1; then
  restore_stash; die "merge of origin/$DEFAULT_BRANCH failed — resolve manually"
fi

log "merge $BRANCH"
if ! g merge "$BRANCH" --no-edit >/dev/null 2>&1; then
  restore_stash; die "merge of $BRANCH failed — resolve manually"
fi

# --- Post-merge JS syntax floor (card 3aa637c5, 2026-07-26 collision incident) ---
# Two concurrent sessions can each cleanly insert the identical line into a
# destructured require() at the same spot; git's 3-way merge doesn't treat
# that as a conflict (each diff applies against its own base, e.g. session A's
# commit lands in origin/main above, then session B's independent commit
# merges in here on top) — the RESULT can still fail to parse ("Identifier
# 'x' has already been declared") with zero git-level conflict. This exact
# incident (shouldShowSentiment double-declared across two sessions' fixes)
# broke main CI for ~10min until a manual dedup commit (3d9caac467c). `node
# --check` on every scripts/**/*.{js,mjs,cjs} file this integration touched
# catches that class instantly and for free, LOCALLY, before the broken merge
# ever reaches origin — instead of waiting for CI to turn main red. Scoped to
# scripts/ only, mirroring the proven tier-3 syntax-floor check in
# scripts/lib/autonomous-checks.js (`node --check` per changed scripts/ file)
# — src/ has JSX/TSX that `node --check` cannot parse; that's tsc's job
# (CLAUDE.md rule 12), unaffected by this addition.
SYNTAX_CHECK_FILES=()
while IFS= read -r f; do
  case "$f" in
    scripts/*.js|scripts/*.mjs|scripts/*.cjs) SYNTAX_CHECK_FILES+=("$f") ;;
  esac
done < <(g diff --name-only --diff-filter=d "$ORIGIN_BASE_SHA" HEAD 2>/dev/null)
if [ ${#SYNTAX_CHECK_FILES[@]} -gt 0 ]; then
  log "syntax-checking ${#SYNTAX_CHECK_FILES[@]} changed scripts/ file(s) (post-merge floor)"
  SYNTAX_FAIL=0
  for f in "${SYNTAX_CHECK_FILES[@]}"; do
    [ -f "$MAIN_DIR/$f" ] || continue
    if ! ERR=$(node --check "$MAIN_DIR/$f" 2>&1); then
      echo "  ✗ $f" >&2
      echo "$ERR" | sed 's/^/      /' >&2
      SYNTAX_FAIL=1
    fi
  done
  if [ "$SYNTAX_FAIL" = 1 ]; then
    restore_stash
    die "post-merge syntax check failed — likely a concurrent-session collision (two branches independently edited the same file; see Notion card 3aa637c5). Resolve the duplication in $MAIN_DIR, commit the fix, then re-run this script."
  fi
fi

# --- Push, integrating remote moves via merge (never rebase) on rejection ---
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN=1 — skipping push"
else
  PUSHED=0
  for attempt in 1 2 3 4 5; do
    OUT=$(g push origin "$DEFAULT_BRANCH" 2>&1)
    # Authoritative success check: is local HEAD now an ancestor of origin? NEVER
    # grep the push output for "main -> main" — the REJECTION line ("! [rejected]
    # main -> main (fetch first)") contains that exact string and falsely reads as
    # success. The ancestor check is ground truth. (2026-06-21: the grep version
    # silently "succeeded" while Phase 2 never reached origin.)
    # Only trust the ancestor check against a FRESHLY-fetched ref. If the fetch
    # itself fails, the remote-tracking ref is stale and the ancestor test would
    # falsely report failure on an otherwise-successful push — so retry the fetch
    # a few times before concluding anything.
    FETCHED=0
    for _fa in 1 2 3; do
      if g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null; then FETCHED=1; break; fi
      sleep 2
    done
    if [ "$FETCHED" = 1 ] && g merge-base --is-ancestor HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null; then
      PUSHED=1; break
    fi
    if echo "$OUT" | grep -qiE "could not resolve host|failed to connect|timed out" || [ "$FETCHED" = 0 ]; then
      restore_stash; die "GitHub unreachable (network) — re-run when connectivity returns. Local merge is intact."
    fi
    log "push rejected (attempt $attempt) — merging remote and retrying"
    g merge "origin/$DEFAULT_BRANCH" --no-edit >/dev/null 2>&1 || { restore_stash; die "could not merge remote changes on retry"; }
  done
  [ "$PUSHED" = 1 ] || { restore_stash; die "push failed after retries"; }
  log "pushed"
fi

restore_stash

# --- VERIFY the files actually landed on origin (the step the incident skipped) ---
if [ "${DRY_RUN:-0}" != "1" ] && [ ${#VERIFY_FILES[@]} -gt 0 ]; then
  FETCHED=0
  for _fa in 1 2 3; do
    if g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null; then FETCHED=1; break; fi
    sleep 2
  done
  [ "$FETCHED" = 1 ] || die "could not fetch origin/$DEFAULT_BRANCH for verify — network issue, re-run when connectivity returns"

  # Existence-only (cat-file -e) proves a same-named file is present at the ref —
  # NOT that it's the content from the commit we just pushed. A concurrent
  # session's push can reset origin/$DEFAULT_BRANCH's tip to an EARLIER commit
  # between our push and this verify step, and an older copy of the same path
  # would still pass the loop below. Re-run the ancestor check (same pattern as
  # the push-retry loop above) against the freshly-fetched ref first — if our
  # HEAD isn't an ancestor of origin's current tip, the tip moved backward
  # under us and the per-file loop cannot be trusted. (card #546, 2026-07-26:
  # this printed ✓✓ for both files while the actual fix content was absent.)
  g merge-base --is-ancestor HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null \
    || die "HEAD is not an ancestor of origin/$DEFAULT_BRANCH — origin's tip moved (concurrent session?) since our push; per-file verify would be unreliable"

  MISSING=0
  echo "── verifying on origin/$DEFAULT_BRANCH ──"
  for f in "${VERIFY_FILES[@]}"; do
    if g cat-file -e "origin/$DEFAULT_BRANCH:$f" 2>/dev/null; then
      echo "  ✓ $f"
    else
      echo "  ✗ MISSING: $f"; MISSING=1
    fi
  done
  [ "$MISSING" = 0 ] || die "some files did NOT land on origin — push reported success but work is missing"
fi

# --- Schedule a delayed re-verify (task #668) ────────────────────────────────
# The verify block above proves the push landed at THIS INSTANT — it cannot
# see a race that resolves after this script exits. #668's incident: this
# exact verify passed (files ✓✓, ancestor check green), then ~10-15 min later
# the merge commit was gone from origin (confirmed via GitHub's contents API,
# not local git — local git state proved unreliable mid-incident). Fire a
# detached background check that re-confirms via the GitHub compare API at
# +2m/+8m/+15m and self-dispatches an alert card if the commit falls off —
# doesn't block this script's exit, doesn't require the caller to babysit it.
if [ "${DRY_RUN:-0}" != "1" ]; then
  MERGE_SHA="$(g rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$MERGE_SHA" ] && command -v node >/dev/null 2>&1; then
    VERIFY_LOG="$MAIN_DIR/data/audit/verify-merge-landed.log"
    mkdir -p "$(dirname "$VERIFY_LOG")" 2>/dev/null || true
    (
      cd "$MAIN_DIR" 2>/dev/null || exit 0
      nohup node scripts/verify-merge-landed.js \
        --sha="$MERGE_SHA" --branch="$DEFAULT_BRANCH" \
        --label="$BRANCH -> $DEFAULT_BRANCH" \
        --delays=120,480,900 </dev/null >>"$VERIFY_LOG" 2>&1 &
    )
    log "delayed re-verify scheduled (+2m/+8m/+15m against $MERGE_SHA) — log: $VERIFY_LOG"
  fi
fi

echo "✅ $BRANCH integrated into $DEFAULT_BRANCH and verified on origin."
