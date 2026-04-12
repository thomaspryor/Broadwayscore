#!/usr/bin/env bash
# prebuild.sh — Runs prebuild scripts with optional skip for code-only changes.
#
# When SKIP_HEAVY_PREBUILD=true, skips most heavy scripts but ALWAYS runs:
#   - validate-shows-prebuild.js (fast validation gate)
#   - generate-show-lookup.js (output is gitignored, must always regenerate)
#   - generate-diary-data.js, build-slug-redirects.js
#   - generate-mobile-show-details.js (public show JSONs must match this build's data)
#
# The remaining scripts produce committed output files that are already current
# in the repo from the last data push. Skipping them for code-only changes
# saves ~1-2 minutes.

set -e

# Always run: validation + gitignored output
node scripts/validate-shows-prebuild.js
node scripts/generate-show-lookup.js
node scripts/generate-diary-data.js
node scripts/build-slug-redirects.js
# Always regenerate public show JSONs — they must match the reviews.json
# used by show pages in THIS build. Skipping this causes 0.1-0.9 pt drift
# when rebuild workflows commit stale public JSONs between deploys. (~30s)
node scripts/generate-mobile-show-details.js

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
node scripts/generate-homepage-archive.js
