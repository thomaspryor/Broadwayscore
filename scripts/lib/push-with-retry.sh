#!/usr/bin/env bash
# Push to remote with retry, rebase, and merge fallback on conflict.
#
# Usage:
#   bash scripts/lib/push-with-retry.sh [max_retries] [branch] [strategy]
#
# Defaults: 5 retries, main branch, theirs strategy.
# strategy: "theirs" (default) = remote wins on conflict,
#           "ours" = local wins on conflict (use for workflows adding
#           non-overlapping data like image paths).
# Exits 0 on success, 1 on failure (all retries exhausted).
#
# Before calling: git add + git commit must already be done.
# After calling: downstream if: always() steps still run on failure.

set -euo pipefail

MAX_RETRIES=${1:-5}
BRANCH=${2:-main}
STRATEGY=${3:-theirs}

pushed=false
for i in $(seq 1 "$MAX_RETRIES"); do
  if git push origin "$BRANCH"; then
    echo "Push succeeded on attempt $i"
    pushed=true
    break
  fi
  echo "Push failed (attempt $i/$MAX_RETRIES), pulling and rebasing..."
  git checkout -- . 2>/dev/null || true
  git clean -fd 2>/dev/null || true
  if git pull --rebase -X "$STRATEGY" origin "$BRANCH"; then
    echo "Rebase succeeded, retrying push..."
  else
    echo "Rebase failed, trying merge fallback..."
    git rebase --abort 2>/dev/null || true
    # Merge fallback: more robust than rebase for binary files and complex JSON diffs
    if git pull --no-rebase -X "$STRATEGY" origin "$BRANCH"; then
      echo "Merge succeeded, retrying push..."
    else
      echo "Merge also failed, will retry..."
    fi
  fi
  WAIT=$((15 + RANDOM % 30))
  echo "Waiting ${WAIT}s before retry..."
  sleep $WAIT
done

if [ "$pushed" != "true" ]; then
  echo "::error::All push attempts failed after $MAX_RETRIES attempts"
  exit 1
fi
