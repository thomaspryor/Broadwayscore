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
# Actor slug manifest — collapses ~2400 data/cast/ files into a single ~1MB
# JSON to keep Vercel's serverless bundle under the 300MB NFT limit.
node scripts/build-actor-slugs-manifest.js
# Cast manifest — same purpose, feeds src/lib/data-actors.ts (which builds
# /cast/[slug] profile pages). Without this, every /cast/[slug] 404s because
# next.config.js excludes data/cast/** from the serverless bundle.
node scripts/build-cast-manifest.js
# Brand tokens — regenerate public/brand-tokens.json from canonical source
node scripts/generate-brand-tokens.js
# Outlet logos — regenerate src/config/outlet-logos-generated.json from the
# canonical outlet-registry.json. Cheap, and the registry is bot-updated ~daily
# (push-core-data), so always regenerate to keep review logos current without a
# manual step. The committed copy is a dev/tsc convenience that this overwrites.
node scripts/generate-outlet-logos.js
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
