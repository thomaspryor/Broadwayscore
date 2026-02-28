#!/usr/bin/env bash
# Push to remote with retry, rebase, and merge fallback on conflict.
#
# Usage:
#   bash scripts/lib/push-with-retry.sh [max_retries] [branch]
#
# Defaults: 5 retries, main branch.
# Exits 0 on success, 1 on failure (all retries exhausted).
#
# Conflict resolution: rebase with -X theirs (= keep our commits' changes).
# If rebase fails entirely (binary files, structural JSON diffs), falls back
# to merge with -X ours (= keep our branch's changes). Both mean "preserve
# the local workflow's data" — the semantics are inverted between rebase and
# merge, so the flags intentionally differ.
#
# Before calling: git add + git commit must already be done.
# After calling: downstream if: always() steps still run on failure.

set -euo pipefail

MAX_RETRIES=${1:-5}
BRANCH=${2:-main}

# BRANCH may be a refspec like "HEAD:main" (for push) or a plain branch
# name like "main". Pull commands need the remote branch name only.
if [[ "$BRANCH" == *:* ]]; then
  PULL_BRANCH="${BRANCH##*:}"
else
  PULL_BRANCH="$BRANCH"
fi

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
  if git pull --rebase -X theirs origin "$PULL_BRANCH"; then
    echo "Rebase succeeded, retrying push..."
  else
    echo "Rebase failed, trying merge fallback..."
    git rebase --abort 2>/dev/null || true
    # Merge fallback: more robust than rebase for binary files and complex JSON diffs.
    # Uses -X ours (= keep our branch) which matches the semantic intent of
    # rebase -X theirs (= keep our commits). The flags differ because git
    # reverses ours/theirs semantics between rebase and merge.
    if git pull --no-rebase -X ours origin "$PULL_BRANCH"; then
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
