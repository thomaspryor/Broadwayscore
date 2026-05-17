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
#
# Wired into ~/.claude/hooks/session-stop.sh so every local session that ends
# (with or without /wrap-up) keeps the mirror fresh. Also re-runnable manually.

set -e

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
for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE="--verbose" ;;
    --dry-run) DRY_RUN="--dry-run" ;;
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

# Make sure INDEX.md + README + .gitattributes survive --delete by living
# under the dest root (they aren't in the source). rsync's --delete only
# touches files that match the include pattern, so non-.md files are safe.

if [ -z "$DRY_RUN" ]; then
  COUNT=$(find "$DEST" -name '*.md' -not -name 'INDEX.md' -not -name 'README.md' | wc -l | tr -d ' ')
  echo "sync-memory-to-repo: $COUNT memory file(s) mirrored to cloud-memory/" >&2
fi
