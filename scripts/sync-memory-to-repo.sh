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

SRC="$HOME/.claude/projects/-Users-tompryor-Broadwayscore/memory"
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
  LOCK="$REPO/.git/cloud-memory-sync.lock"
  # Clear a stale lock from a crashed run (>10 min old)
  find "$LOCK" -maxdepth 0 -mmin +10 -exec rmdir {} \; 2>/dev/null || true
  if mkdir "$LOCK" 2>/dev/null; then
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT

    # Upfront marker check, BEFORE any git operation touches the checkout —
    # same convention as push-with-retry.sh's BRO-142 guard
    # (scripts/lib/push-with-retry.sh:379-391): refuse to touch a checkout
    # that already has a MERGE_HEAD/REBASE_HEAD/etc marker before this run
    # touched anything (task #1893 follow-up). Two failure modes this avoids,
    # confirmed by manual repro:
    #   1. `git commit -q ... -- cloud-memory/` does NOT refuse merely because
    #      REBASE_HEAD is set (unlike MERGE_HEAD, which blocks any partial
    #      commit) — without this check, a stray in-progress rebase from
    #      elsewhere on the shared checkout would silently get an unrelated
    #      cloud-memory commit landed on top of it mid-resolution.
    #   2. memory-sync-pull.js's own `git merge --abort` only covers a merge
    #      THIS run started and failed. Against a PRE-EXISTING marker, its
    #      `git merge` call fails immediately (MERGE_HEAD already exists) and
    #      its abort fallback (`merge --abort`, then `rebase --abort`) would
    #      abort a live session's in-progress conflict resolution outside any
    #      mutex — exactly the auto-recovery detect-stale-merge-head.sh's
    #      header says a 6-reviewer plan-review explicitly rejected.
    # Fail-open (skip the check) if the lib file is missing, matching
    # push-with-retry.sh's own convention.
    _sync_marker_preexisting=""
    if [ -f "$REPO/scripts/lib/detect-stale-merge-head.sh" ]; then
      # shellcheck source=scripts/lib/detect-stale-merge-head.sh
      source "$REPO/scripts/lib/detect-stale-merge-head.sh"
      for _sync_marker in ${STALE_MARKER_TYPES:-MERGE_HEAD}; do
        _sync_result=$(marker_staleness "$REPO" "$_sync_marker")
        if [ "${_sync_result%% *}" != "none" ]; then
          _sync_marker_preexisting="$_sync_marker"
          break
        fi
      done
    fi

    BRANCH=$(git -C "$REPO" branch --show-current 2>/dev/null)
    if [ -n "$_sync_marker_preexisting" ]; then
      echo "sync-memory-to-repo: existing $_sync_marker_preexisting found before this run touched anything — refusing to touch the checkout; will retry next session-stop" >&2
    elif [ "$BRANCH" != "main" ]; then
      echo "sync-memory-to-repo: main checkout is on '$BRANCH', not main — skipping commit" >&2
    elif [ -n "$(git -C "$REPO" status --porcelain -- cloud-memory/ 2>/dev/null)" ]; then
      git -C "$REPO" add cloud-memory/
      if git -C "$REPO" commit -q -m "chore: sync cloud-memory (session-stop auto-commit)" -- cloud-memory/; then
        if ! git -C "$REPO" push -q origin main 2>/dev/null; then
          # Behind origin (CI commits constantly) — reconcile via merge, never
          # rebase (repo policy: scripts/merge-worktree-to-main.sh), and never
          # leave conflict residue on the shared checkout (task #1893: a
          # rebase left `.git/rebase-merge` behind here and wedged every other
          # session's push via push-with-retry.sh's BRO-142 guard). The
          # upfront marker check above already ruled out a pre-existing
          # marker, so any residue memory-sync-pull.js aborts here is one
          # this run's own merge attempt just created.
          if node "$REPO/scripts/lib/memory-sync-pull.js" --repo "$REPO"; then
            git -C "$REPO" push -q origin main 2>/dev/null ||
              echo "sync-memory-to-repo: commit created but push failed (offline/race) — it will ride out with the next push" >&2
          else
            echo "sync-memory-to-repo: could not reconcile with origin/main — commit stays local, checkout left clean, will retry next session-stop" >&2
          fi
        fi
        echo "sync-memory-to-repo: cloud-memory committed to main" >&2
      fi
    fi
  else
    echo "sync-memory-to-repo: another session holds the sync lock — skipping commit" >&2
  fi
fi
