#!/usr/bin/env bash
#
# Weekly GC for .claude/worktrees: remove worktrees whose branch is fully
# merged into origin/main.
#
# SAFETY: never uses --force. `git worktree remove` (plain) refuses to remove a
# worktree that has uncommitted changes OR a branch with unmerged commits — that
# refusal IS the safety property we want. The job only ever removes worktrees
# that are both (a) on a branch whose every commit already landed in origin/main
# (squash-merges included, via `git cherry`) and (b) clean enough that git is
# willing to remove them. Branches are KEPT (never `branch -d`) so no history is
# lost. Installed via launchd: ~/Library/LaunchAgents/com.broadwayscore.worktree-gc.plist
#
# Manual run / dry-run:
#   scripts/gc-merged-worktrees.sh            # remove merged+clean worktrees
#   scripts/gc-merged-worktrees.sh --dry-run  # report only, change nothing
#
set -uo pipefail

REPO="/Users/tompryor/Broadwayscore"
LOG="$REPO/data/audit/worktree-gc.log"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

cd "$REPO" || { echo "repo not found: $REPO" >&2; exit 1; }
mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

git fetch origin main -q 2>/dev/null || log "WARN: git fetch failed (offline?) — using cached origin/main"

removed=0 kept=0 skipped=0

# Parse `git worktree list --porcelain` into (path, branch) pairs.
path="" branch=""
flush() {
  [ -z "$path" ] && return
  # Skip the main checkout.
  if [ "$path" = "$REPO" ]; then path="" branch=""; return; fi
  if [ -z "$branch" ]; then
    log "SKIP  $(basename "$path") — detached HEAD, leaving alone"
    skipped=$((skipped+1)); path="" branch=""; return
  fi
  # Leave worktrees owned by notion-action-poll.js alone. It creates
  # `action-<cardid>` worktrees off origin/main (so they read as "merged" the
  # instant they're created) and manages their full lifecycle with --force. A
  # freshly-created one is briefly clean before its agent writes anything — a
  # narrow window where this GC could remove it out from under an active poll.
  case "$(basename "$path")" in
    action-*) log "SKIP  $(basename "$path") — notion-action-poll worktree, owner-managed"
              skipped=$((skipped+1)); path="" branch=""; return ;;
  esac
  # Merged iff `git cherry` reports no commit missing from upstream ('+' prefix).
  # Empty output (branch == origin/main) also counts as merged.
  local unmerged
  unmerged=$(git cherry origin/main "$branch" 2>/dev/null | grep -c '^+')
  if [ "$unmerged" != "0" ]; then
    log "KEEP  $(basename "$path") — $unmerged unmerged commit(s) on $branch"
    kept=$((kept+1)); path="" branch=""; return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "WOULD-REMOVE  $(basename "$path") — $branch fully merged"
    removed=$((removed+1)); path="" branch=""; return
  fi
  # Plain remove (NO --force): git refuses if the working tree is dirty.
  if git worktree remove "$path" 2>/dev/null; then
    log "REMOVE $(basename "$path") — $branch merged, worktree removed (branch kept)"
    removed=$((removed+1))
  else
    log "SKIP  $(basename "$path") — merged but worktree dirty; not forcing"
    skipped=$((skipped+1))
  fi
  path="" branch=""
}

while IFS= read -r line; do
  case "$line" in
    "worktree "*) flush; path="${line#worktree }" ;;
    "branch refs/heads/"*) branch="${line#branch refs/heads/}" ;;
    "detached") branch="" ;;
  esac
done < <(git worktree list --porcelain)
flush

git worktree prune 2>/dev/null
log "DONE  removed=$removed kept=$kept skipped=$skipped (dry_run=$DRY_RUN)"
