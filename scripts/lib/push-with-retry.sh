#!/usr/bin/env bash
# Push to remote with retry and automatic conflict resolution for state files.
#
# Usage:
#   bash scripts/lib/push-with-retry.sh [max_retries] [branch]
#
# Defaults: 7 retries, main branch.
# Exits 0 on success, 1 on failure (all retries exhausted).
#
# Conflict resolution strategy:
#   1. Try git push (fast path, no conflict)
#   2. On failure: fetch remote, attempt rebase
#   3. If rebase has conflicts in collection-state/ or audit/ files:
#      auto-resolve by keeping local run's data (these are per-run state
#      files that don't need three-way merging)
#   4. If rebase still fails: abort and try merge with same auto-resolution
#   5. Retry with random jitter to avoid thundering herd
#
# Key insight: git swaps ours/theirs semantics between rebase and merge:
#   - Rebase: "ours" = remote base, "theirs" = our commits being replayed
#   - Merge:  "ours" = our branch,  "theirs" = remote being merged in
# This script handles both correctly.
#
# Before calling: git add + git commit must already be done.
# After calling: downstream if: always() steps still run on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MAX_RETRIES=${1:-7}
BRANCH=${2:-main}

# BRANCH may be a refspec like "HEAD:main" (for push) or a plain branch
# name like "main". Pull commands need the remote branch name only.
if [[ "$BRANCH" == *:* ]]; then
  PULL_BRANCH="${BRANCH##*:}"
else
  PULL_BRANCH="$BRANCH"
fi

# Auto-resolve conflicts by keeping our run's version of state files.
# Args: $1 = "rebase" or "merge" (determines ours/theirs mapping)
#
# During rebase: our commits = "theirs", remote base = "ours"
# During merge:  our branch = "ours",   remote = "theirs"
resolve_conflicts() {
  local mode="${1:-merge}"
  local resolved=false
  local conflicted_files
  conflicted_files=$(git diff --name-only --diff-filter=U 2>/dev/null || true)

  if [ -z "$conflicted_files" ]; then
    return 1  # No conflicts to resolve
  fi

  echo "  Conflicted files ($mode mode):"
  echo "$conflicted_files" | sed 's/^/    /'

  # Determine the correct flag to keep "our run's data" vs "remote's data"
  local keep_local keep_remote
  if [ "$mode" = "rebase" ]; then
    keep_local="--theirs"   # In rebase: theirs = our commits being replayed
    keep_remote="--ours"    # In rebase: ours = the remote base
  else
    keep_local="--ours"     # In merge: ours = our branch
    keep_remote="--theirs"  # In merge: theirs = remote being merged
  fi

  while IFS= read -r file; do
    case "$file" in
      data/collection-state/*|data/audit/*)
        # State files: keep our run's version (each run writes independently)
        echo "  Auto-resolving (keep local): $file"
        git checkout $keep_local "$file" 2>/dev/null && git add "$file" 2>/dev/null && resolved=true
        ;;
      *)
        # Other data files: accept remote (other workflows' changes)
        echo "  Auto-resolving (keep remote): $file"
        git checkout $keep_remote "$file" 2>/dev/null && git add "$file" 2>/dev/null && resolved=true
        ;;
    esac
  done <<< "$conflicted_files"

  if [ "$resolved" = "true" ]; then
    return 0
  fi
  return 1
}

# After rebase/merge, restore any manually-set correction fields
# (humanReviewScore, manualContentTier, etc.) that -X theirs silently dropped.
# These fields are ONLY set by humans, never by CI — always safe to restore.
restore_protected_fields() {
  if ! command -v node &>/dev/null; then return 0; fi
  local remote_ref="origin/$PULL_BRANCH"
  local count
  count=$(node "$SCRIPT_DIR/restore-protected-fields.js" "$remote_ref" 2>&1 | tail -1)
  if [ "$count" -gt 0 ] 2>/dev/null; then
    echo "  Restored protected fields in $count file(s) after rebase"
    git add -A
    git commit --amend --no-edit 2>/dev/null || true
  fi
}

pushed=false
for i in $(seq 1 "$MAX_RETRIES"); do
  if git push origin "$BRANCH"; then
    echo "Push succeeded on attempt $i"
    pushed=true
    break
  fi

  echo "Push failed (attempt $i/$MAX_RETRIES), fetching remote and rebasing..."
  git fetch origin "$PULL_BRANCH" 2>/dev/null || true

  # Attempt 1: rebase with theirs strategy (= keep our commits' content)
  # In rebase context: "theirs" = our commits being replayed
  rebase_ok=false
  if git rebase -X theirs "origin/$PULL_BRANCH" 2>/dev/null; then
    rebase_ok=true
    restore_protected_fields
  else
    echo "  Rebase had conflicts, attempting auto-resolution..."
    # Try up to 4 rounds of conflict resolution (one per conflicting commit)
    for _round in 1 2 3 4; do
      if resolve_conflicts rebase; then
        if GIT_EDITOR=true git rebase --continue 2>/dev/null; then
          rebase_ok=true
          echo "  Rebase completed after $_round round(s) of conflict resolution"
          restore_protected_fields
          break
        fi
      else
        break  # No more conflicts to resolve but rebase still stuck
      fi
    done

    if [ "$rebase_ok" != "true" ]; then
      echo "  Rebase could not be completed, aborting..."
      git rebase --abort 2>/dev/null || true
    fi
  fi

  # Attempt 2: merge fallback (more robust for complex JSON conflicts)
  if [ "$rebase_ok" != "true" ]; then
    echo "  Trying merge fallback..."
    # -X ours in merge context = keep our branch's version
    if git merge "origin/$PULL_BRANCH" -X ours --no-edit 2>/dev/null; then
      echo "  Merge succeeded"
      restore_protected_fields
    elif resolve_conflicts merge && git commit --no-edit 2>/dev/null; then
      echo "  Merge succeeded after auto-resolving conflicts"
      restore_protected_fields
    else
      echo "  Merge also failed, aborting..."
      git merge --abort 2>/dev/null || true
      # Last resort: reset to remote, then cherry-pick our commit on top.
      # This guarantees we end up ahead of remote with our changes applied.
      echo "  Trying reset + cherry-pick approach..."
      OUR_HEAD=$(git rev-parse HEAD 2>/dev/null || true)
      if [ -n "$OUR_HEAD" ]; then
        git reset --hard "origin/$PULL_BRANCH" 2>/dev/null || true
        if git cherry-pick "$OUR_HEAD" --strategy-option=theirs 2>/dev/null; then
          echo "  Cherry-pick succeeded (our changes on top of remote)"
          restore_protected_fields
        else
          git cherry-pick --abort 2>/dev/null || true
          git reset --hard "$OUR_HEAD" 2>/dev/null || true
          echo "  All conflict resolution strategies failed for this attempt"
        fi
      fi
    fi
  fi

  # Add jitter: 10-45s to spread out concurrent push retries
  WAIT=$((10 + RANDOM % 35))
  echo "  Waiting ${WAIT}s before retry..."
  sleep "$WAIT"
done

if [ "$pushed" != "true" ]; then
  echo "::error::All push attempts failed after $MAX_RETRIES attempts"
  exit 1
fi
