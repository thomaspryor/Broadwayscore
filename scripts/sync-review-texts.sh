#!/bin/bash
# Syncs local review-texts changes to the private repo.
# Run this after ANY local modification to data/review-texts/ files.
# CI workflows handle their own pushes — this is for local/Claude sessions only.

set -euo pipefail

REVIEW_TEXTS_DIR="$(cd "$(dirname "$0")/../data/review-texts" && pwd)"

if [ ! -d "$REVIEW_TEXTS_DIR/.git" ]; then
  echo "ERROR: $REVIEW_TEXTS_DIR is not a git repo. Clone the private repo first:"
  echo "  git clone https://github.com/thomaspryor/broadway-review-texts.git data/review-texts"
  exit 1
fi

cd "$REVIEW_TEXTS_DIR"

# Check for changes
git add -A
if git diff --staged --quiet; then
  echo "No review-texts changes to sync."
  exit 0
fi

CHANGED=$(git diff --staged --stat | tail -1)
echo "Changes: $CHANGED"

# Commit
COMMIT_MSG="${1:-data: Sync local review-texts changes}"
git commit -m "$COMMIT_MSG" -m "Changed: $CHANGED"

# Push with retry (same logic as CI composite action, simplified)
for i in 1 2 3 4 5; do
  if git pull --rebase origin main 2>&1; then
    # Resolve any conflicts by keeping ours (local is always newer for local sessions)
    UNMERGED=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
    if [ -n "$UNMERGED" ]; then
      echo "Resolving $( echo "$UNMERGED" | wc -l | tr -d ' ') conflicts (keeping local versions)..."
      echo "$UNMERGED" | while IFS= read -r f; do
        git checkout --theirs "$f" 2>/dev/null || true
        git add "$f"
      done
      GIT_EDITOR=true git rebase --continue 2>/dev/null || true
    fi

    if git push origin main 2>&1; then
      echo "Review-texts synced successfully (attempt $i)."
      exit 0
    fi
  fi

  echo "Attempt $i failed, retrying in 5s..."
  git rebase --abort 2>/dev/null || true
  sleep 5
done

echo "ERROR: Failed to sync after 5 attempts."
exit 1
