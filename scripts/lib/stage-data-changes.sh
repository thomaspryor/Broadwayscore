#!/usr/bin/env bash
# Stage data file changes while ALWAYS excluding private/copyrighted paths.
#
# Usage:
#   bash scripts/lib/stage-data-changes.sh [path ...]
#
# With no arguments: stages all of data/ (minus exclusions).
# With arguments:    stages only the listed paths (minus exclusions).
#
# Excluded paths (copyrighted content that must never hit the public repo):
#   - data/aggregator-archive/   (scraped HTML archives)
#   - data/review-texts/         (full-text reviews)
#
# The exclusions are enforced via git pathspec negation (:!prefix).
# They apply even if a caller accidentally passes one of these paths.
#
# Examples:
#   # Stage everything under data/ except private paths
#   bash scripts/lib/stage-data-changes.sh
#
#   # Stage specific directories (exclusions still enforced)
#   bash scripts/lib/stage-data-changes.sh data/audit/ data/collection-state/
#
#   # Stage data/ plus non-data paths
#   bash scripts/lib/stage-data-changes.sh data/ public/images/shows/
#
# Before calling: ensure the working tree has the changes you want staged.
# After calling:  run `git diff --staged --quiet` to check if anything was staged.

set -euo pipefail

# Paths that must NEVER be committed to the public repo.
EXCLUDE_PATHS=(
  ':!data/aggregator-archive/'
  ':!data/review-texts/'
)

# Default to data/ if no arguments provided
if [ $# -eq 0 ]; then
  PATHS=("data/")
else
  PATHS=("$@")
fi

# Stage with exclusions. || true because git add exits non-zero if
# a path doesn't exist or matches nothing (common in CI).
git add "${PATHS[@]}" "${EXCLUDE_PATHS[@]}" 2>/dev/null || true
