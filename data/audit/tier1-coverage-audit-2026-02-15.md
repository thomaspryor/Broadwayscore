# Tier 1 Outlet Coverage Audit
**Date:** 2026-02-15
**Scope:** All 28 open shows + system-wide `duplicateTextOf` bug fix

## Critical Bug Fixed: Circular `duplicateTextOf` Exclusions

**Root cause:** When `collect-review-texts.js` detected same text in two files (e.g., `variety--aramide-tinubu.json` and `variety--peter-marks.json`), it marked BOTH with `duplicateTextOf` pointing to each other. The rebuild script (line 1434) skipped any file with this flag — causing BOTH copies to be excluded and ZERO surviving.

**Impact:** 1,348 total `duplicateTextOf` flags in the corpus; 964 were circular/stale (reference file either missing or also flagged). Affected 250 Tier 1 outlet-show combinations and 380 other outlets.

**Fix:** Modified `rebuild-all-reviews.js` to check if the referenced file also has `duplicateTextOf` (circular) or doesn't exist (stale). In those cases, the file is let through; the later fingerprint dedup handles actual duplicates. Result: **+470 net new reviews** (12,218 → 12,688).

21 stale flags (reference file deleted but flag remained) also recovered.

## Big 3 Coverage (NYT, Vulture, Variety) — Open Shows

**After fix:** 22/28 (79%) open shows have all Big 3. Before fix: 14/28 (50%).

### Shows Still Missing Big 3 Reviews

| Show | Reviews | Missing | Reason |
|------|---------|---------|--------|
| Hamilton | 40 | NYT, Vulture | Off-Broadway files exist (Feb 2015). Broadway reviews (Aug 2015) never gathered. `playbillVerdictUrl` has correct Broadway NYT URL |
| Marjorie Prime | 26 | Vulture, Variety | Vulture file is wrongProduction (2015 off-Broadway). Variety has no file — true gap |
| SIX | 24 | Vulture | File exists but contains wrong text (NYTG review misattributed as Vulture) |
| Two Strangers | 19 | Variety | No file — true gap. Show opened Nov 2025, Variety may not have reviewed yet |
| Chicago | 19 | Vulture | No file — true gap. 1996 show, Vulture didn't exist then |
| All Out | 1 | NYT, Vulture, Variety | Very new show (Dec 2025). NYT file exists but filtered (no score). True gaps for Vulture/Variety |

### Actionable Fixes

**Hamilton (CRITICAL — most important show on Broadway):**
- The Broadway NYT URL is known: `nytimes.com/2015/08/07/theater/review-hamilton-young-rebels-changing-history-and-theater.html`
- Need to create correct Broadway review files for NYT, Vulture, THR, Guardian, NewYorker
- Also missing: broadwaynews, latimes, timeout (has circular dupe — only 1 of 2 copies survived)

**SIX:**
- Delete or overwrite `vulture--helen-shaw.json` (contains wrong text)
- Trigger collection for the actual Helen Shaw Vulture review of SIX

**Marjorie Prime & Two Strangers:**
- Trigger `gather-reviews.yml` for these shows to discover Variety reviews
- Marjorie Prime may not have Variety coverage (not all shows get it)

## Tier 1 Per-Outlet Coverage (Open Shows)

| Outlet | Coverage | Notes |
|--------|----------|-------|
| NYTimes | 26/28 (93%) | Missing: Hamilton (has off-Broadway), All Out (too new) |
| Variety | 25/28 (89%) | Missing: Marjorie Prime, Two Strangers, All Out |
| Timeout | 25/28 (89%) | Missing: Two Strangers, Chicago, All Out |
| Vulture | 23/28 (82%) | 5 missing — 2 true gaps, 2 filtered, 1 wrong text |
| WSJ | 23/28 (82%) | |
| WashPost | 20/28 (71%) | |
| BwayNews | 15/28 (54%) | Older shows less likely to have BwayNews coverage |
| Guardian | 11/28 (39%) | UK outlet, doesn't review every Broadway show |
| THR | 9/28 (32%) | |
| NewYorker | 8/28 (29%) | Selective — only reviews notable shows |
| AP | 7/28 (25%) | Wire service, coverage spotty |
| LATimes | 2/28 (7%) | Rarely covers Broadway |

## Hamilton Deep-Dive (5 of 12 Tier 1 Outlets Missing)

| Outlet | Status | Issue |
|--------|--------|-------|
| NYTimes | FILTERED | Off-Broadway (Feb 2015). Broadway URL known |
| Vulture | FILTERED | Off-Broadway (Feb 2015) |
| THR | FILTERED | Circular `duplicateTextOf` (2 files, both excluded) — fixed but both have same text → fingerprint dedup keeps only 1 → but the "1" is also filtered? Need investigation |
| Guardian | FILTERED | wrongProduction flag |
| NewYorker | FILTERED | wrongProduction flag |
| BwayNews | TRUE GAP | No file exists |
| LATimes | TRUE GAP | No file exists |
| Variety | OK | 1 review |
| WashPost | OK | 1 review |
| WSJ | OK | 1 review |
| Timeout | OK | 1 review (from 2 circular dupes, 1 survived) |
| AP | OK | 1 review |

## Recommendations

1. **Hamilton:** Priority — find and add Broadway-era review files (Aug 2015 NYT, Vulture). This is the biggest show on Broadway and shouldn't be missing its most important reviews.
2. **System-wide:** Run `gather-reviews.yml` for all shows still missing Variety/Vulture reviews
3. **SIX:** Fix the misattributed vulture file (delete and re-gather)
4. **Data quality:** Audit all `duplicateTextOf` flags to find more cases where different-outlet reviews have identical text (misattribution during scraping)
5. **Prevention:** Consider modifying `collect-review-texts.js` to not create circular `duplicateTextOf` flags — only mark the second file as a dupe of the first
