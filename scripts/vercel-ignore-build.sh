#!/bin/bash
# Vercel Ignore Build Step
# Exit 0 = SKIP build (ignore)
# Exit 1 = PROCEED with build
#
# Only rebuild when files that affect the static export change.
# Skip builds for data/review-texts/ checkpoints, audit files,
# aggregator archives, scripts, workflows, and tests.
#
# IMPORTANT: Vercel uses shallow clones (depth 1), so git diff HEAD^
# doesn't work — HEAD^ doesn't exist. We use VERCEL_GIT_COMMIT_MESSAGE
# (always available) to identify data-only commits by their prefix.

echo "Commit message: $VERCEL_GIT_COMMIT_MESSAGE"

# --- Phase 1: Fast skip via commit message prefix ---
# These prefixes are ONLY used by automated pipelines for data-only changes.
case "$VERCEL_GIT_COMMIT_MESSAGE" in
  "chore: Checkpoint"*)     echo "Data checkpoint — skipping build"; exit 0 ;;
  "health: "*)              echo "Health record — skipping build"; exit 0 ;;
  "checkpoint: "*)          echo "Scoring checkpoint — skipping build"; exit 0 ;;
esac

# --- Phase 2: File diff (if git history is available) ---
# Deepen the shallow clone so HEAD^ exists
git fetch --deepen=2 2>/dev/null

DIFF=$(git diff HEAD^ HEAD --name-only 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$DIFF" ]; then
  # Can't compute diff — safe default: build
  echo "Cannot compute diff — proceeding with build"
  exit 1
fi

# Build if any build-relevant files changed
if echo "$DIFF" | grep -qE '^(src/|public/|content/|next\.config|vercel\.json|tailwind|tsconfig|package|data/(shows|reviews|grosses|grosses-history|commercial|audience-buzz|critic-consensus|lottery-rush|awards|gold-lists-computed|critic-registry)\.json)'; then
  echo "Build-relevant files changed — proceeding with build"
  exit 1
fi

echo "Only non-build files changed — skipping build"
exit 0
