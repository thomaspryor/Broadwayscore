# Historical Broadway Season Expansion Plan

**Created:** February 2, 2026
**Status:** Phases 0-3 COMPLETE. Phase 4 (quality audit) pending.

**Result:** 643 historical shows added on Feb 2, 2026 (commit `a99216f45`). DB went from ~87 to **730 shows**.

---

## Current State (Updated Feb 2, 2026)

| Season | Shows in DB | Notes |
|--------|-------------|-------|
| 2025-2026 | 26 | Current season, still in progress |
| 2024-2025 | 42 | Complete |
| 2023-2024 | 37 | Complete |
| 2022-2023 | 39 | Complete |
| 2021-2022 | 36 | Complete |
| 2019-2020 | 19 | Shorter (COVID) |
| 2017-2018 | 33 | Complete |
| 2016-2017 | 39 | Complete |
| 2015-2016 | 36 | Complete |
| 2014-2015 | 35 | Complete |
| 2013-2014 | 41 | Complete |
| 2012-2013 | 40 | Complete |
| 2011-2012 | 42 | Complete |
| 2010-2011 | 39 | Complete |
| 2009-2010 | 39 | Complete |
| 2008-2009 | 39 | Complete |
| 2007-2008 | 36 | Complete |
| 2006-2007 | 35 | Complete |
| 2005-2006 | 39 | Complete |

**40 shows remain in `historical-shows-pending.json`** (all 2005-2006 season) — likely duplicates or specials that were filtered out during discovery.

**Original target:** 500-600 new shows. **Actual:** 643 added.

---

## ~~Blocker: Data Source Broken~~ RESOLVED

~~Broadway.org season archives returned 404.~~ **Fixed:** `discover-historical-shows.js` was rewritten to scrape IBDB season pages (`ibdb.com/season/{numericId}`) using ScrapingBee premium proxy. IBDB has structured data with title, type, opening date, and theater for every production.

---

## ~~Pre-Expansion Bug Fixes~~ ALL FIXED

All three bugs (slug collision, revival type detection, URL-year guard) were fixed in the IBDB rewrite before the historical discovery run.

---

## Execution Plan

### ~~Phase 0: Fix blocker + bugs~~ DONE
IBDB rewrite completed. All 3 bugs fixed. Dry-run validated.

### ~~Phase 1: Complete 2024-2025 season~~ DONE
42 shows now in DB for 2024-2025.

### ~~Phase 2: Complete 2023-2024 season~~ DONE
37 shows in DB for 2023-2024.

### ~~Phase 3: Work backwards one season at a time~~ DONE
All seasons from 2005-2006 through 2022-2023 discovered and committed in a single run (`a99216f45`). 643 new shows added.

### Phase 4: Quality audit — NOT STARTED

After all seasons are loaded:

1. Run text quality audit — check coverage percentages
2. Run cross-show fingerprint detection — catch duplicate reviews
3. Check for multi-production routing issues (Cabaret, Chicago, Gypsy, Company, Sweeney Todd, etc.)
4. Verify scoring distribution looks reasonable for historical shows
5. Update CLAUDE.md with new show count and coverage stats
6. Trigger review gathering workflows for historical shows (in batches)
7. Let nightly crons handle text collection and scoring

**Next steps:** Trigger `gather-reviews.yml` for historical shows in batches, then let nightly `collect-review-texts.yml` and `rebuild-reviews.yml` handle the rest.

---

## Review Coverage Expectations by Era

| Era | Expected Coverage | Aggregator Sources |
|-----|-------------------|-------------------|
| 2020-2025 | Excellent (15-25 reviews/show) | Show Score, DTLI, BWW, Playbill Verdict, NYC Theatre |
| 2015-2020 | Good (10-20 reviews/show) | DTLI, BWW, some Show Score |
| 2010-2015 | Moderate (5-15 reviews/show) | DTLI, BWW |
| 2005-2010 | Sparse (3-10 reviews/show) | DTLI, some BWW |
| Pre-2005 | Minimal (0-5 reviews/show) | Not recommended |

**Key insight:** DTLI (didtheylikeit.com) has the best historical coverage, going back to early 2000s. Show Score only covers ~2015+. For pre-2010 shows, the NYSR WordPress API may also have coverage.

---

## API Cost Estimates

| Step | Cost Per Show | Per Season (~35 shows) |
|------|--------------|----------------------|
| Discovery (IBDB scrape) | ~$0.002 (ScrapingBee) | ~$0.07 |
| IBDB date enrichment | ~$0.01 (Google SERP + scrape) | ~$0.35 |
| Review gathering | ~$0.05 (5 aggregators) | ~$1.75 |
| Image fetching | ~$0.02 (TodayTix/Playbill) | ~$0.70 |
| Review text collection | ~$0.10-0.50 (Browserbase/ScrapingBee) | ~$3.50-17.50 |
| LLM scoring | ~$0.02 per review (3-model ensemble) | ~$7-15 |
| **Total per season** | | **~$13-35** |
| **15 seasons** | | **~$200-525** |

Most expensive step is LLM scoring (Claude + GPT-4o + Gemini per review). Review text collection depends on how many need Browserbase ($0.10/session).

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| IBDB blocks scraping | Use ScrapingBee premium proxy; rate limit 1.5s between requests; we already do this for individual production pages |
| Multi-production confusion | `isMultiProduction()` bypass on all dedup checks; date-aware `matchTitleToShow()` — both shipped today |
| Review misattribution to wrong production | Adaptive URL-year guard uses `max(openingYear+2, closingYear+1)`; NYSR passes publish year to matcher |
| Overwhelming nightly cron | Process 1-2 seasons at a time; checkpoint architecture in collect-review-texts means no work lost on timeout |
| Image unavailability for old shows | TodayTix API won't have old shows; fall back to Playbill/Google image search; some shows will have no images |
| shows.json grows very large | Currently ~87 shows = ~200KB. At 600 shows, ~1.4MB. Still fine for static JSON import. |

---

## Files Modified

| File | Change |
|------|--------|
| `scripts/discover-historical-shows.js` | **Rewrite** — switch from Broadway.org to IBDB data source |
| `scripts/discover-historical-shows.js` | Fix slug collision (set `slug = id`) |
| `scripts/discover-historical-shows.js` | Fix revival type detection |
| `.github/workflows/discover-historical-shows.yml` | Add SCRAPINGBEE_API_KEY secret (already present) |

No changes needed to downstream pipeline — gather-reviews, collect-review-texts, rebuild, LLM scoring all handle new shows automatically.

---

## Decision: How Far Back?

**Recommended: 20 years (2005-2006 season)**

- ~2005 is when online review coverage becomes reliable
- DTLI coverage goes back to early 2000s
- Show Score starts ~2015
- Pre-2005 shows would have very few scoreable reviews
- Can always extend further later if desired

**Total new shows estimated: ~500-600**
**Estimated total cost: ~$200-500**
**Estimated calendar time: 1-2 weeks** (1-2 seasons/day with overnight automation)
