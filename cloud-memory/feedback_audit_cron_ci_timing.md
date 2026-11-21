---
name: Audit cron CI timing — local 2x scaling
description: CI runs of muckrack-fetching audit scripts are ~2x slower than local; size workflow timeouts accordingly
type: feedback
archived: true
---

When productionizing a /tmp prototype audit script that fetches from external sources (Muckrack, Bright Data, ScrapingBee), CI runtime is ~2x what you measured locally — even with the same fetchPage code path.

**Why:** GitHub Actions runner IPs hit BD/SB rate limits more aggressively than residential IPs. Plus muckrack.com's anti-scrape pressure varies by source ASN.

**How to apply:** When you measure local audit time T, set workflow `timeout-minutes` to at least 4×T (gives 2x headroom over the 2x-scaling expectation). For the critic-coverage audit:
- Local 4-page depth × 69 critics = ~30 min → set 60 min and you'll hit timeout
- Local 2-page depth × 69 critics = ~15 min → 120-min timeout = 8x headroom = comfortable
- Reduce per-critic page depth if total runtime starts approaching the cap

**Real incident:** 2026-04-26 first production run of audit-critic-coverage.yml cancelled at 60-min timeout. Fix: bumped to 120 min, dropped maxPages 4→2.
