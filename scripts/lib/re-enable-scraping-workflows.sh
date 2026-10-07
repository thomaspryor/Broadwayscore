#!/usr/bin/env bash
# Re-enable the 7 scraping workflows disabled during a ScrapingBee credit crunch.
#
# Usage:
#   bash scripts/lib/re-enable-scraping-workflows.sh
#
# Background: these were disabled 2026-04-03 (BRO-679) to conserve SB credits
# for opening nights while credits were at 14%. Safe to re-run at any time —
# `gh workflow enable` is a no-op on an already-active workflow. Before
# running, sanity-check SB credit headroom:
#   curl -s "https://app.scrapingbee.com/api/v1/usage?api_key=$SCRAPINGBEE_API_KEY"
set -euo pipefail

WORKFLOWS=(
  collect-outlet-reviews.yml
  scrape-new-aggregators.yml
  scrape-bww-reviews.yml
  scrape-dtli-show-score.yml
  fix-platform-ticket-links.yml
  recollect-for-scores.yml
  rediscover-urls.yml
)

for wf in "${WORKFLOWS[@]}"; do
  echo "Enabling $wf..."
  gh workflow enable "$wf"
done

echo "Done. Verify with: gh workflow list --all"
