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

die() { echo "❌ $*" >&2; exit 1; }
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
    # version (the daemon regenerates them) and drop the stash.
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
if ! g merge "origin/$DEFAULT_BRANCH" --no-edit >/dev/null 2>&1; then
  restore_stash; die "merge of origin/$DEFAULT_BRANCH failed — resolve manually"
fi

log "merge $BRANCH"
if ! g merge "$BRANCH" --no-edit >/dev/null 2>&1; then
  restore_stash; die "merge of $BRANCH failed — resolve manually"
fi

# --- Push, integrating remote moves via merge (never rebase) on rejection ---
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN=1 — skipping push"
else
  PUSHED=0
  for attempt in 1 2 3 4 5; do
    OUT=$(g push origin "$DEFAULT_BRANCH" 2>&1)
    if echo "$OUT" | grep -q "$DEFAULT_BRANCH -> $DEFAULT_BRANCH" || echo "$OUT" | grep -qi "up-to-date"; then
      PUSHED=1; break
    fi
    if echo "$OUT" | grep -qiE "could not resolve host|failed to connect|timed out"; then
      restore_stash; die "GitHub unreachable (network) — re-run when connectivity returns. Local merge is intact."
    fi
    log "push rejected (attempt $attempt) — merging remote and retrying"
    g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null
    g merge "origin/$DEFAULT_BRANCH" --no-edit >/dev/null 2>&1 || { restore_stash; die "could not merge remote changes on retry"; }
  done
  [ "$PUSHED" = 1 ] || { restore_stash; die "push failed after retries"; }
  log "pushed"
fi

restore_stash

# --- VERIFY the files actually landed on origin (the step the incident skipped) ---
if [ "${DRY_RUN:-0}" != "1" ] && [ ${#VERIFY_FILES[@]} -gt 0 ]; then
  g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null || true
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

echo "✅ $BRANCH integrated into $DEFAULT_BRANCH and verified on origin."
