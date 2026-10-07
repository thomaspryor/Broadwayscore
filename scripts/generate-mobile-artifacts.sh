#!/usr/bin/env bash
#
# Single source of truth for regenerating BOTH mobile artifacts together:
#   - public/data/shows/{id}.json   (DETAIL)  via generate-mobile-show-details.js
#   - public/data/mobile-shows.json (INDEX)   via generate-mobile-data.js
#   (the index step also writes analyst-shows.json / analyst-creatives.json)
#
# Why this exists: the two generators were copy-pasted across ~7 call sites
# (prebuild.sh, rebuild-fast, rebuild-reviews, opening-night-broadcast/-poller,
# backfill-cast*). When a site regenerated DETAIL but not INDEX, the index went
# stale relative to the build and validate-mobile-shows.js reddened main
# (2026-06-22 incident, commit 6f9e196939). Routing every site through one
# wrapper makes "regenerate one, forget the other" structurally impossible.
#
# The two scripts read the SAME core-data files and write DISJOINT outputs, so
# order is not load-bearing; we run detail then index to match prebuild.sh.
#
# STAGING IS NOT THIS SCRIPT'S JOB — each workflow keeps its own `git add`
# rules (the cast backfills stage only public/data/shows/; the rebuild pipeline
# stages both). generate-mobile-data.js writes single-line JSON with a `_ts`
# timestamp, so committers should keep their has-changes-only gate (see
# cloud-memory/feedback_mobile_index_committed_artifact.md).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node "$ROOT/scripts/generate-mobile-show-details.js"
node "$ROOT/scripts/generate-mobile-data.js"
# Show Stats artifacts (design-ios-show-stats.md §8). stats-reviews reads the
# detail files written above, so it must stay after generate-mobile-show-details.
node "$ROOT/scripts/generate-stats-canon.js"
node "$ROOT/scripts/generate-stats-reviews.js"
