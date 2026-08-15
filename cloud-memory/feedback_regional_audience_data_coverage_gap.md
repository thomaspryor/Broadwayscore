---
name: feedback_regional_audience_data_coverage_gap
description: "La Jolla Playhouse / Bucks County Playhouse / RSC Stratford-upon-Avon tryouts have zero audience-grade coverage — confirmed structural data-source gap, not a pipeline bug"
metadata: 
  node_type: memory
  type: project
  originSessionId: c02b66da-16e5-4e04-830b-535890fdfa5f
  modified: 2026-08-15T04:00:03.481Z
---

6 of 16 regional shows in shows.json have zero audience-buzz coverage (no Mezzanine, no Reddit), clustered at exactly 3 venues:
- La Jolla Playhouse, CA — The Outsiders (world premiere, 2023), 3 Summers of Lincoln (2025), The Family Album (2026)
- Bucks County Playhouse, PA — The Apple Boys (2025), Starstruck (2026)
- RSC Stratford-upon-Avon, UK — Game of Thrones: The Mad King (2026)

Confirmed 2026-08-15 by directly re-running both scrapers against The Outsiders and 3 Summers of Lincoln:
- **Mezzanine**: 0 matches for either show (`node scripts/scrape-mezzanine-audience.js --shows=...`). Mezzanine's own rater base simply doesn't reach La Jolla Playhouse — contrast with the 10 regional shows that DO have Mezzanine data, all at NYC-adjacent/major feeder houses (A.R.T. Cambridge, Arena Stage DC, Goodman/Steppenwolf/Chicago Shakespeare, Alliance Atlanta, Fisher Center Nashville, Two River NJ).
- **Reddit**: 3 Summers of Lincoln has real discussion (4 posts, 23 comments) but only ~6 usable items after filtering — under `MIN_REDDIT_ITEMS = 50` in `scripts/lib/audience-weighting.js`'s `isRedditEligible()`, so `calculateCombinedScore` returns `score: null` and no grade gets written. This is correct behavior, not a bug.

**This is NOT a pipeline coverage-sweep gap.** The weekly Mezzanine cron (`update-mezzanine.yml`) already runs against every show in shows.json including all regional-category entries, and has its own built-in near-miss title-drift audit (`data/audit/mezzanine-coverage.json`). The gap is upstream: these specific venues have no audience-rating platform we track. Not worth building bespoke scraper infrastructure for ~6 small-house tryout productions.

Do not re-investigate this as a bug if it's flagged again (e.g. via a feedback-form submission) — re-verify with a direct `--shows=` scraper dispatch if the show list has changed, but expect the same result for shows at these 3 venues.

Related tangent found the same day: [[feedback_theatr_coverage_audit_market_filter]] (Theatr coverage-audit false positives on West End shows — separate bug, already fixed 2026-08-13, unrelated to this gap).
