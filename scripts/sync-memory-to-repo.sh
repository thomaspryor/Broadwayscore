#!/bin/bash
# sync-memory-to-repo.sh — mirror the local user-level memory dir into the repo
# so cloud Claude Code sessions (iOS, Mac app, web) can see accumulated learnings.
#
# Claude Code's auto-memory loader reads from ~/.claude/projects/<encoded-cwd>/memory/
# — a cloud sandbox doesn't have that path, so without this mirror cloud sessions
# get zero project learnings. This script keeps cloud-memory/ in the repo in sync
# with the local-authoritative source.
#
# Idempotent. Safe to run multiple times; only changed files are copied.
#
# MERGE-AWARE, NOT REPLACE-FROM-MASTER (BRO-103). This used to be a plain
# `rsync -a --delete`, which silently deleted any memo a cloud or parallel
# session had committed straight into cloud-memory/ (that dir has a second set
# of writers — cloud sessions have no ~/.claude to write to). 2026-05-24:
# cloud-memory/feedback_nonprofit_venue_vs_production.md was wiped 12 minutes
# after a cloud session committed it. The reconcile now runs through
# scripts/lib/cloud-memory-merge.js, which uses a last-sync manifest as the
# common ancestor so it can tell "the owner deleted this locally" (delete it
# from the mirror) apart from "this arrived from somewhere else" (adopt it into
# the local memory dir). Nothing is ever dropped without a copy surviving.
#
# Invocation:
#   ./scripts/sync-memory-to-repo.sh                # silent unless changed
#   ./scripts/sync-memory-to-repo.sh --verbose      # show every file copied
#   ./scripts/sync-memory-to-repo.sh --dry-run      # show what would change
#   ./scripts/sync-memory-to-repo.sh --commit       # also commit+push the mirror
#
# Wired into ~/.claude/hooks/session-stop.sh (with --commit) so every local
# session that ends keeps the mirror fresh AND lands it on origin/main — a
# mirror that's synced but never committed is invisible to cloud sessions
# (2026-07-11: 11 files sat untracked; nothing in any workflow commits this dir).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# MEMORY_SYNC_SRC overrides the source dir for tests only (see
# scripts/cloud-memory-sync.test.mjs, which drives this script end-to-end
# against scratch dirs); production callers never set it.
SRC="${MEMORY_SYNC_SRC:-$HOME/.claude/projects/-Users-tompryor-Broadwayscore/memory}"
# Always sync to the main Broadwayscore repo (not whatever worktree cwd happens
# to be in when SessionStop fires). Cloud-memory/ lives in main; worktree
# branches will see it on next pull/merge.
# MEMORY_SYNC_REPO overrides the target repo for manual testing against a
# scratch clone (see scripts/lib/memory-sync-pull.test.mjs and the card #1893
# manual acceptance step) — production callers never set this.
REPO="${MEMORY_SYNC_REPO:-$HOME/Broadwayscore}"
DEST="$REPO/cloud-memory"

if [ ! -d "$SRC" ]; then
  echo "sync-memory-to-repo: source $SRC does not exist — likely running from cloud sandbox; skipping" >&2
  exit 0
fi

mkdir -p "$DEST"

VERBOSE=""
DRY_RUN=""
DO_COMMIT=""
for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE="--verbose" ;;
    --dry-run) DRY_RUN="--dry-run" ;;
    --commit) DO_COMMIT=1 ;;
  esac
done

# Root-level *.md only, on both sides — no checkpoints, scratch files,
# subdirectories, or anything else that might appear in either dir. (Same
# filter the old `--include='*.md' --exclude='*' --prune-empty-dirs` rsync
# applied; cloud-memory-merge.js reimplements it in hashDir().)
#
# The merge is deletion-safe by construction: a mirror-side file is only
# removed when the manifest proves this script put it there AND nobody has
# touched it since. Anything else is adopted back into $SRC.
# Copy forward but NEVER pass --delete. Fail-safe direction: a stale extra
# file in the mirror is recoverable, a deleted memo written by a cloud session
# is not. Used when node or the merge lib is missing, and when the merge
# itself fails.
_copy_without_deleting() {
  rsync -a $VERBOSE $DRY_RUN \
    --include='*.md' \
    --exclude='*' \
    --prune-empty-dirs \
    "$SRC/" "$DEST/"
}

MERGE_LIB="$SCRIPT_DIR/lib/cloud-memory-merge.js"
if ! command -v node >/dev/null 2>&1 || [ ! -f "$MERGE_LIB" ]; then
  echo "sync-memory-to-repo: node/merge lib unavailable — copying without deletions" >&2
  _copy_without_deleting
# `if !` rather than a bare call: under `set -e` a THROWING merge (an fs error,
# not just a missing node) would abort this script outright, and session-stop.sh
# invokes us as `... --commit 2>&1 | grep -v ... >/dev/null || true` — so the
# mirror would silently stop syncing forever with no signal anywhere. `if !` is
# exempt from set -e, which turns a crash into a loud warning plus the
# no-deletion fallback.
elif ! node "$MERGE_LIB" "$SRC" "$DEST" --repo="$REPO" $VERBOSE $DRY_RUN; then
  echo "sync-memory-to-repo: merge failed — falling back to a copy with NO deletions" >&2
  _copy_without_deleting
fi

# NOTE ON LOCKING: the merge deliberately runs outside the $LOCK below (which
# only guards the git commit/push). Two session-stops racing here cannot lose
# data: a mirror-side file is only ever deleted when the manifest proves we
# mirrored it AND the local source no longer has it, and neither of those
# becomes true because of an interleave. The worst case is a redundant copy
# that the next run no-ops. Don't "fix" this by widening the lock — that would
# serialise every session-stop behind a 663-file hash walk.

# NOTE: the mirror's entry point is MEMORY.md (synced from the source index).
# A hand-placed extra .md here is no longer deleted — it is adopted into the
# local memory dir on the next sync, so don't hand-place files you don't want
# to become real memories.

if [ -z "$DRY_RUN" ]; then
  COUNT=$(find "$DEST" -name '*.md' | wc -l | tr -d ' ')
  echo "sync-memory-to-repo: $COUNT memory file(s) mirrored to cloud-memory/" >&2
fi

# --- Optional commit+push (session-stop passes --commit) ---------------------
# The mirror only helps cloud sessions once it's on origin/main. Serialized via
# a lock dir (parallel sessions can stop simultaneously); commits ONLY paths
# under cloud-memory/ from the MAIN checkout on the main branch. Push failures
# never fail the hook — the commit stays local and rides out with later traffic.
if [ -n "$DO_COMMIT" ] && [ -z "$DRY_RUN" ]; then
  LOCK="$REPO/.git/cloud-memory-sync.lock"

  # push-mutex.sh is the SAME fleet-wide lock push-with-retry.sh and
  # merge-worktree-to-main.sh hold around their own fetch/rebase/merge flows
  # (keyed off git-common-dir, so it's shared by the main checkout and every
  # worktree). Held below around this script's fetch+merge retry so it can't
  # interleave with another session's in-flight rebase/merge on the same
  # checkout — task #1893 ship-check finding: without this, memory-sync-
  # pull.js's own pre-existing-marker check has a TOCTOU window (another
  # session's operation can start between the check and the merge). Sourced
  # here, not just inside the retry branch, so _cloud_memory_sync_cleanup
  # (registered next) can always call push_mutex_release safely regardless
  # of which branch runs. Guarded on the file existing (fail OPEN): a
  # checkout predating this file must behave exactly as before.
  if [ -f "$SCRIPT_DIR/lib/push-mutex.sh" ]; then
    # shellcheck source=scripts/lib/push-mutex.sh
    source "$SCRIPT_DIR/lib/push-mutex.sh"
  fi
  if [ -f "$SCRIPT_DIR/lib/detect-stale-merge-head.sh" ]; then
    # shellcheck source=scripts/lib/detect-stale-merge-head.sh
    source "$SCRIPT_DIR/lib/detect-stale-merge-head.sh"
  fi

  _cloud_memory_sync_cleanup() {
    command -v push_mutex_release >/dev/null 2>&1 && push_mutex_release
    rmdir "$LOCK" 2>/dev/null || true
  }

  # Clear a stale lock from a crashed run (>10 min old)
  find "$LOCK" -maxdepth 0 -mmin +10 -exec rmdir {} \; 2>/dev/null || true
  if mkdir "$LOCK" 2>/dev/null; then
    trap _cloud_memory_sync_cleanup EXIT
    BRANCH=$(git -C "$REPO" branch --show-current 2>/dev/null)
    if [ "$BRANCH" != "main" ]; then
      echo "sync-memory-to-repo: main checkout is on '$BRANCH', not main — skipping commit" >&2
    elif [ -n "$(git -C "$REPO" status --porcelain -- cloud-memory/ 2>/dev/null)" ]; then
      # Acquire the mutex and check for a pre-existing marker BEFORE the
      # first git mutation, not just before the reconcile-on-push-failure
      # branch — task #1893 follow-up (ship-check + manual repro): a
      # pathspec-limited `git commit -q ... -- cloud-memory/` FAILS OUTRIGHT
      # ("cannot do a partial commit during a merge") the instant MERGE_HEAD
      # already exists, before this script's own reconcile logic ever runs.
      # REBASE_HEAD is worse: `git commit` does NOT refuse for it, so a stray
      # in-progress rebase from elsewhere would silently get an unrelated
      # cloud-memory commit landed on top of it mid-resolution. Checking once,
      # upfront, under the mutex (closing the same TOCTOU window
      # push-with-retry.sh's ordering closes) avoids both.
      command -v push_mutex_acquire >/dev/null 2>&1 && push_mutex_acquire

      BLOCKED_MARKER=""
      if command -v marker_staleness >/dev/null 2>&1; then
        for _marker in ${STALE_MARKER_TYPES:-MERGE_HEAD}; do
          _result=$(marker_staleness "$REPO" "$_marker")
          _status="${_result%% *}"
          if [ "$_status" != "none" ]; then
            BLOCKED_MARKER="$_marker"
            echo "sync-memory-to-repo: existing $_marker found before this run touched anything — refusing to touch the checkout (BRO-142)." >&2
            marker_staleness_message "$REPO" "$_marker" "$_status" "${_result#* }" >&2
            break
          fi
        done
      fi
      unset _result _status _marker

      if [ -n "$BLOCKED_MARKER" ]; then
        echo "sync-memory-to-repo: cloud-memory mirror left uncommitted — will retry next session-stop" >&2
        command -v push_mutex_release >/dev/null 2>&1 && push_mutex_release
      else
        git -C "$REPO" add cloud-memory/
        if git -C "$REPO" commit -q -m "chore: sync cloud-memory (session-stop auto-commit)" -- cloud-memory/; then
          PUSHED=""
          if git -C "$REPO" push -q origin main 2>/dev/null; then
            PUSHED=1
          else
            # Behind origin (CI commits constantly) — merge (NEVER rebase;
            # the repo's own policy, see merge-worktree-to-main.sh —
            # `pull --rebase` silently drops merge commits) and retry once,
            # still under the same mutex hold from above (no re-check needed:
            # nothing else could have started an operation here without
            # first taking this mutex). On conflict, memory-sync-pull.js
            # aborts cleanly instead of leaving .git/rebase-merge residue
            # that wedges every OTHER session's push via
            # push-with-retry.sh's own BRO-142 guard (task #1893).
            if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/memory-sync-pull.js" ]; then
              node "$SCRIPT_DIR/lib/memory-sync-pull.js" "$REPO" >&2 || true
            fi
            if git -C "$REPO" push -q origin main 2>/dev/null; then PUSHED=1; fi
          fi
          if [ -n "$PUSHED" ]; then
            echo "sync-memory-to-repo: cloud-memory committed and pushed to main" >&2
          else
            echo "sync-memory-to-repo: commit created but push failed (offline/race) — it will ride out with the next push" >&2
          fi
        fi
        command -v push_mutex_release >/dev/null 2>&1 && push_mutex_release
      fi
    fi
  else
    echo "sync-memory-to-repo: another session holds the sync lock — skipping commit" >&2
  fi
fi
