#!/bin/bash
# Vercel Ignore Build Step
# Exit 0 = SKIP build (ignore)
# Exit 1 = PROCEED with build
#
# Only rebuild when files that affect the static export change.
# Skip builds for data/review-texts/ checkpoints, audit files,
# aggregator archives, scripts, workflows, and tests.

# Safe default: if we can't compute a diff, always build
DIFF=$(git diff HEAD^ HEAD --name-only 2>/dev/null) || exit 1

# If no files changed, skip
if [ -z "$DIFF" ]; then
  echo "No files changed — skipping build"
  exit 0
fi

# Build if any build-relevant files changed:
#   src/          - application code
#   public/       - static assets
#   content/      - blog reviews (markdown)
#   next.config   - Next.js config
#   vercel.json   - Vercel config
#   tailwind      - Tailwind config
#   tsconfig      - TypeScript config
#   package       - dependencies
#   data/*.json   - specific data files imported by Next.js at build time
#     (shows, reviews, grosses, grosses-history, commercial,
#      audience-buzz, critic-consensus, lottery-rush, awards,
#      gold-lists-computed, critic-registry)
if echo "$DIFF" | grep -qE '^(src/|public/|content/|next\.config|vercel\.json|tailwind|tsconfig|package|data/(shows|reviews|grosses|grosses-history|commercial|audience-buzz|critic-consensus|lottery-rush|awards|gold-lists-computed|critic-registry)\.json)'; then
  echo "Build-relevant files changed — proceeding with build"
  exit 1
fi

echo "Only non-build files changed — skipping build"
exit 0
