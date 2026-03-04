#!/usr/bin/env bash
# prebuild.sh — Runs prebuild scripts with optional skip for code-only changes.
#
# When SKIP_HEAVY_PREBUILD=true, only runs the two mandatory scripts:
#   - validate-shows-prebuild.js (fast validation gate)
#   - generate-show-lookup.js (output is gitignored, must always regenerate)
#
# The other 6 scripts produce committed output files that are already current
# in the repo from the last data push. Skipping them for code-only changes
# saves ~1-2 minutes.

set -e

# Always run: validation + gitignored output
node scripts/validate-shows-prebuild.js
node scripts/generate-show-lookup.js

if [ "$SKIP_HEAVY_PREBUILD" = "true" ]; then
  echo "Skipping heavy prebuild (code-only change — committed data files are current)"
  exit 0
fi

# Full prebuild: regenerate all data files
node scripts/generate-search-shows.js
node scripts/compute-gold-lists.js
node scripts/generate-blog-reviews-for-scoring.js
node scripts/generate-review-og-images.js
node scripts/generate-mobile-data.js
node scripts/generate-mobile-show-details.js
