---
name: Stability guards need staleness awareness
description: "Hardcoded thresholds death-spiral when stale; scale with gap or --force."
type: feedback
archived: true
---

Hardcoded stability guards (e.g., "abort if >10 new shows") create death spirals when a pipeline goes stale. Each failed run increases the gap, making the next run even more likely to fail.

**Why:** scrape-cast-changes.js had a threshold of 10 new show IDs per run. After 7 weeks of failures, 14+ new shows accumulated. Every weekly run tripped the guard and discarded all scraped data (including Claude API calls already made).

**How to apply:** Any stability guard in a scraper or pipeline should either:
1. Scale thresholds with data staleness (e.g., base 10, +5 per stale week, max 50)
2. Have a `--force` flag to bypass for recovery runs
3. Or both

Also: guards should run BEFORE expensive operations (API calls, scraping) when possible, not after.
