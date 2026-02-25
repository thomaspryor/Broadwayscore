#!/usr/bin/env bash
# Push to remote with retry and rebase on conflict.
#
# Usage:
#   bash scripts/lib/push-with-retry.sh [max_retries] [branch]
#
# Defaults: 5 retries, main branch.
# Exits 0 on success, 1 on failure (all retries exhausted).
#
# Before calling: git add + git commit must already be done.
# After calling: downstream if: always() steps still run on failure.

set -euo pipefail

MAX_RETRIES=${1:-5}
BRANCH=${2:-main}

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
  if git pull --rebase -X theirs origin "$BRANCH"; then
    echo "Rebase succeeded, retrying push..."
  else
    echo "Rebase failed, aborting..."
    git rebase --abort 2>/dev/null || true
  fi
  sleep $((10 + RANDOM % 20))
done

if [ "$pushed" != "true" ]; then
  echo "::error::All push attempts failed after $MAX_RETRIES attempts"
  exit 1
fi
