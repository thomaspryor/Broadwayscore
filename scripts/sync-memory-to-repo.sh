#!/bin/bash
# sync-memory-to-repo.sh — mirror the local user-level memory dir into the repo
# so cloud Claude Code sessions (iOS, Mac app, web) can see accumulated learnings.
#
# Claude Code's auto-memory loader reads from ~/.claude/projects/<encoded-cwd>/memory/
# — a cloud sandbox doesn't have that path, so without this mirror cloud sessions
# get zero project learnings. This script keeps cloud-memory/ in the repo in sync
# with the local-authoritative source.
#
# Idempotent. Safe to run multiple times. rsync only copies changed files.
# --delete propagates local deletions to the mirror.
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

SRC="$HOME/.claude/projects/-Users-tompryor-Broadwayscore/memory"
# Always sync to the main Broadwayscore repo (not whatever worktree cwd happens
# to be in when SessionStop fires). Cloud-memory/ lives in main; worktree
# branches will see it on next pull/merge.
DEST="$HOME/Broadwayscore/cloud-memory"

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

# --include='*.md' --exclude='*' --prune-empty-dirs limits the mirror to
# memory markdown files only — no checkpoints, scratch files, or anything else
# that might appear in the source dir.
rsync -a --delete $VERBOSE $DRY_RUN \
  --include='*.md' \
  --exclude='*' \
  --prune-empty-dirs \
  "$SRC/" "$DEST/"

# NOTE: --delete removes any dest-root .md not present in the source — that's
# how the old INDEX.md/README.md got deleted. The mirror's entry point is
# MEMORY.md (synced from the source index); don't hand-place extra .md files here.

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
  REPO="$HOME/Broadwayscore"
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
      git -C "$REPO" add cloud-memory/
      if git -C "$REPO" commit -q -m "chore: sync cloud-memory (session-stop auto-commit)" -- cloud-memory/; then
        PUSHED=""
        if git -C "$REPO" push -q origin main 2>/dev/null; then
          PUSHED=1
        else
          # Behind origin (CI commits constantly) — merge (NEVER rebase; the
          # repo's own policy, see merge-worktree-to-main.sh — `pull --rebase`
          # silently drops merge commits) and retry once, under the shared
          # push-mutex. Marker check runs AFTER acquiring the mutex (BRO-142
          # ordering) so a marker that appears is genuinely foreign, not a
          # race with this run's own check. On conflict, memory-sync-pull.js
          # aborts cleanly instead of leaving .git/rebase-merge residue that
          # wedges every OTHER session's push via push-with-retry.sh's own
          # BRO-142 guard (task #1893).
          command -v push_mutex_acquire >/dev/null 2>&1 && push_mutex_acquire

          BLOCKED_MARKER=""
          if command -v marker_staleness >/dev/null 2>&1; then
            for _marker in ${STALE_MARKER_TYPES:-MERGE_HEAD}; do
              _result=$(marker_staleness "$REPO" "$_marker")
              _status="${_result%% *}"
              if [ "$_status" != "none" ]; then
                BLOCKED_MARKER="$_marker"
                marker_staleness_message "$REPO" "$_marker" "$_status" "${_result#* }" >&2
                break
              fi
            done
          fi

          if [ -z "$BLOCKED_MARKER" ] && command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/memory-sync-pull.js" ]; then
            node "$SCRIPT_DIR/lib/memory-sync-pull.js" "$REPO" >&2 || true
          fi

          command -v push_mutex_release >/dev/null 2>&1 && push_mutex_release

          if git -C "$REPO" push -q origin main 2>/dev/null; then PUSHED=1; fi
        fi
        if [ -n "$PUSHED" ]; then
          echo "sync-memory-to-repo: cloud-memory committed and pushed to main" >&2
        else
          echo "sync-memory-to-repo: commit created but push failed (offline/race) — it will ride out with the next push" >&2
        fi
      fi
    fi
  else
    echo "sync-memory-to-repo: another session holds the sync lock — skipping commit" >&2
  fi
fi
