#!/bin/bash
# Vercel Ignore Build Step
# Exit 0 = SKIP build (ignore)
# Exit 1 = PROCEED with build

echo "::Ignore Build Step::"

# Get commit message — try git log first (works in any clone, even shallow),
# then fall back to Vercel env var, then to empty string.
MSG=$(git log -1 --format=%s 2>/dev/null)
if [ -z "$MSG" ]; then
  MSG="$VERCEL_GIT_COMMIT_MESSAGE"
fi
echo "Commit subject: $MSG"

# Skip data-only commits by their prefix (set by GitHub Actions pipelines)
case "$MSG" in
  "chore: Checkpoint"*)  echo "SKIP: data checkpoint";  exit 0 ;;
  "health: "*)           echo "SKIP: health record";     exit 0 ;;
  "checkpoint: "*)       echo "SKIP: scoring checkpoint"; exit 0 ;;
  "Merge remote-tracking branch"*) ;;
  # Add more skip patterns here as needed
esac

# For all other commits, try file-based detection
# Deepen shallow clone so HEAD^ exists
git fetch --deepen=2 2>/dev/null
DIFF=$(git diff HEAD^ HEAD --name-only 2>/dev/null)

if [ -z "$DIFF" ]; then
  echo "BUILD: cannot compute diff, safe default"
  exit 1
fi

echo "Changed files:"
echo "$DIFF"

# Build only if build-relevant files changed
if echo "$DIFF" | grep -qE '^(src/|public/|content/|next\.config|vercel\.json|tailwind|tsconfig|package|data/(shows|reviews|grosses|grosses-history|commercial|audience-buzz|critic-consensus|lottery-rush|awards|gold-lists-computed|critic-registry)\.json)'; then
  echo "BUILD: build-relevant files changed"
  exit 1
fi

echo "SKIP: only data/infra files changed"
exit 0
