---
name: Cast changes pipeline lessons
description: Three operational lessons from building the cast changes scraper — checkpointing, SERP query breadth, and guard design
type: feedback
archived: true
---

Three lessons from the cast changes pipeline build (2026-04-05):

1. **Checkpoint before guards, not after.** The scraper ran 45 min of API calls, then a stability guard discarded all results. Any pipeline that does expensive work (LLM extraction, scraping) MUST checkpoint incrementally so crashes/guards don't lose everything. Pattern: save to disk every 10 shows + after each source completes. Workflow commit step needs `if: always()`.

**Why:** 165 article extractions ($2+ in API calls) were discarded because the guard ran after all work was done.

**How to apply:** Any new scraper that runs >5 minutes should checkpoint. Use the `setCheckpointData()` + `checkpoint()` pattern from scrape-cast-changes.js.

2. **SERP queries must include a keyword-free variant.** Queries like `site:playbill.com "Show Title" (cast OR joining)` miss articles with creative titles ("Oh, Maya!"). Always include `site:playbill.com "Show Title" broadway` as the first query.

**Why:** Maya Rudolph's Oh Mary casting was on Playbill but not returned by keyword-heavy queries.

**How to apply:** Any SERP-based article discovery should lead with a broad query, then add keyword-specific queries for precision.

3. **Stability guards should warn on additions, abort only on removals.** New show IDs appearing is normal growth. Shows being removed indicates data corruption. The guard was aborting on additions, creating a death spiral where each failure made the next one worse.

**Why:** Article scraper finds OB/WE shows mentioned in Broadway articles. These are legitimate data, not corruption.

**How to apply:** In any data pipeline guard, additions = expected growth (warn), removals = potential corruption (abort).
