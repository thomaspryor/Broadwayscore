#!/usr/bin/env bash
# Stage data file changes while ALWAYS excluding private/copyrighted paths.
#
# Usage:
#   bash scripts/lib/stage-data-changes.sh [path ...]
#
# With no arguments: stages all of data/ (minus exclusions).
# With arguments:    stages only the listed paths (minus exclusions).
#
# Excluded paths (copyrighted content / billing PII that must never hit the public repo):
#   - data/aggregator-archive/   (scraped HTML archives)
#   - data/review-texts/         (full-text reviews)
#   - data/finances/             (billing receipts + P&L ledgers — PII)
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Paths that must NEVER be committed to the public repo.
EXCLUDE_PATHS=(
  ':!data/aggregator-archive/'
  ':!data/review-texts/'
  ':!data/finances/'
)

# Dual-tracked core-data files (task #989): gitignored + private-repo-owned,
# but stray-tracked in the public repo's git index too. checkout-core-data
# always overwrites data/$f with the private repo's checkout-time copy,
# regardless of whether THIS workflow touches it — so a blind `git add data/`
# can stage and commit that copy as a "change," reverting a fix that landed
# only in the public repo (confirmed: two same-day multiAuthor:true
# corrections to outlet-registry.json reverted by unrelated poller commits).
# Exclude any of them that this run's snapshot-identity check shows were
# NOT actually modified during this workflow (see core-data-public-stage-
# exclusions.js — mirrors push-core-data's opposite-direction check).
# Escape hatch for a script that intentionally edits one of these directly:
# REGISTRY_CHANGE_INTENDED=1.
if [ "${REGISTRY_CHANGE_INTENDED:-}" != "1" ] && command -v node >/dev/null 2>&1; then
  while IFS= read -r f; do
    [ -n "$f" ] && EXCLUDE_PATHS+=(":!$f")
  done < <(node "$SCRIPT_DIR/core-data-public-stage-exclusions.js" 2>/dev/null || true)
fi

# Default to data/ if no arguments provided
if [ $# -eq 0 ]; then
  PATHS=("data/")
else
  PATHS=("$@")
fi

# Stage with exclusions. || true because git add exits non-zero if
# a path doesn't exist or matches nothing (common in CI).
git add "${PATHS[@]}" "${EXCLUDE_PATHS[@]}" 2>/dev/null || true
