#!/usr/bin/env bash
# prebuild.sh: Prepare ignored prerequisites for every build. Local builds use
# the committed published artifacts; CI/Vercel regenerate them for deployment.
# REGENERATE_BUILD_DATA=true opts a local build into those tracked data writes.
#
# On the publishing path, SKIP_HEAVY_PREBUILD=true skips heavy scripts but runs:
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
# App recommendations: slim copy of data/related-shows.json (gitignored, served at /data/related-shows-mobile.json)
node scripts/generate-related-shows-mobile.js
# Actor slug manifest — collapses ~2400 data/cast/ files into a single ~1MB
# JSON to keep Vercel's serverless bundle under the 300MB NFT limit.
node scripts/build-actor-slugs-manifest.js
# Cast manifest — same purpose, feeds src/lib/data-actors.ts (which builds
# /cast/[slug] profile pages). Without this, every /cast/[slug] 404s because
# next.config.js excludes data/cast/** from the serverless bundle.
node scripts/build-cast-manifest.js
# Coverage-floor snapshot — data/audit/** is excluded from the server
# functions, so pages re-rendered at runtime read this slim copy of the
# floor's verdicts/stamps/acks instead (BRO-5811; traced via next.config.js).
node scripts/build-coverage-floor-snapshot.js

# A normal local build is a consumer of published data, like next dev. Rebuilding
# committed artifacts from a newer private-data snapshot dirties thousands of
# files (and timestamp-only changes dirty even an otherwise identical snapshot).
# Keep local builds read-only for those artifacts. Direct generator commands and
# the explicit refresh flag remain available for intentional data updates.
if [ "${CI:-}" != "true" ] && [ "${CI:-}" != "1" ] && \
   [ "${VERCEL:-}" != "1" ] && [ "${VERCEL:-}" != "true" ] && \
   [ "${REGENERATE_BUILD_DATA:-}" != "true" ]; then
  node scripts/generate-stats-shows.js
  echo "Using committed build data (local build). Set REGENERATE_BUILD_DATA=true to refresh it."
  exit 0
fi

# Slug redirects — AFTER the cast manifest: the "cast:" family of
# data/slug-redirects-compact.json (retired pre-fold /cast/<slug> URLs, S7-T3
# follow-up) is derived from data/cast-manifest.json, so this build's manifest
# has to exist first or the map would carry the previous build's cast pages.
node scripts/build-slug-redirects.js
# Brand tokens — regenerate public/brand-tokens.json from canonical source
node scripts/generate-brand-tokens.js
# Outlet logos — regenerate src/config/outlet-logos-generated.json from the
# canonical outlet-registry.json. Cheap, and the registry is bot-updated ~daily
# (push-core-data), so always regenerate to keep review logos current without a
# manual step. The committed copy is a dev/tsc convenience that this overwrites.
node scripts/generate-outlet-logos.js
# Blog reviews (Tier 3 critic injection) — MUST run before generate-mobile-show-details.js
# and compute-gold-lists.js below, both of which read blog-reviews-for-scoring.json via
# scripts/lib/load-reviews-with-blog.js. This script only parses ~4 markdown files, so it's
# cheap enough to always run rather than risk the exact stale-read drift its own header
# comment documents (compute-gold-lists.js/generate-mobile-show-details.js showing a
# different score than the live show page — task #1908).
node scripts/generate-blog-reviews-for-scoring.js
# Always regenerate public show JSONs — they must match the reviews.json
# used by show pages in THIS build. Skipping this causes 0.1-0.9 pt drift
# when rebuild workflows commit stale public JSONs between deploys. (~30s)
node scripts/generate-mobile-show-details.js

# Web Stats catalog (gitignored): a slim projection of mobile-shows.json, so it
# runs on BOTH paths — here from the committed mobile-shows.json, and at the end
# of the full path from the freshly regenerated one.
if [ "$SKIP_HEAVY_PREBUILD" = "true" ]; then
  echo "Skipping heavy prebuild (code-only change — committed data files are current)"
  node scripts/generate-stats-shows.js
  exit 0
fi

# Full prebuild: regenerate all data files
node scripts/generate-search-shows.js
node scripts/compute-gold-lists.js
node scripts/generate-review-og-images.js
node scripts/generate-mobile-data.js
# After generate-mobile-data.js: projects its output (see the fast path above).
node scripts/generate-stats-shows.js
node scripts/generate-homepage-archive.js
node scripts/generate-off-broadway-archive.js
node scripts/generate-off-west-end-archive.js
node scripts/generate-west-end-archive.js
