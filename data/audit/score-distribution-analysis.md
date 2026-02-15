# Score Distribution Analysis — Feb 15, 2026

## Summary
**12,218 reviews across 736 shows. No launch-blocking issues found.**

One bug fixed (5 bogus "0/5" ratings → 0/100 scores). One guard added (reject 0-star ratings as scraping artifacts). All other findings are legitimate patterns.

## Global Distribution
- Mean: 71.2 | Median: 77 | StdDev: 16.0
- Range: 0-100 | P5: 42 | P25: 62 | P75: 82 | P95: 92
- Healthy bell curve centered around 70-80 (expected for Broadway — most shows are at least decent)

## Bugs Fixed
- **5 reviews with "originalScore: 0/5"** — scraping artifacts from ShowScore numeric-stars extraction. Produced 0/100 scores on positive reviews. Fixed: removed bogus `originalScore` from 5 source files + added guard in `parseStarRating()` to reject 0-star ratings.
- Shows affected: A View from the Bridge (2015), Kiss Me Kate (2019), The Boys in the Band (2018), The Country Girl (2008), Indecent (2017)

## Verified Legitimate Patterns

### Extreme Scores Are Real
- **86 reviews scored <20** — all have unambiguously negative excerpts ("excruciating," "amazing bore," "disastrous"). All with 3/4 or 4/4 LLM model agreement.
- **201 reviews scored 100** — all from parsed "5/5 stars" or "100" originalScore. Legitimate perfect scores.
- **No open/previews shows have extreme averages** (<30 or >95) — clean for launch.

### Divisive Shows Are Genuinely Divisive
- Wicked (std=23, range 15-92): Michael Feingold and John Simon were famously hostile, others loved it. Correct.
- The Boys in the Band (std=21, range 0-100): mix of opinions. Correct.

### Outlet/Critic Averages Are Legitimate
- Toughest: Slant Magazine (62.4), amNewYork (63.3), Bloomberg (63.3) — known tough outlets
- Most generous: Digital Journal (88.9) — one critic (Markos Papadatos), 10/22 reviews at 100. Real but generous.
- EW high average (79.6) — driven by letter grades (332/410 reviews). EW gives lots of B+ and A- grades.

### Score Source Bias
| Source | Avg | StdDev | Count | Notes |
|--------|-----|--------|-------|-------|
| llmScore | 70.9 | 15.8 | 8,213 | Main method |
| llmScore-lowconf | 70.2 | 15.3 | 2,110 | Excerpt-only |
| originalScore-priority0 | 74.6 | 17.8 | 1,692 | Real ratings (skew positive — critics who rate tend toward generous) |
| thumb | 71.9 | 10.3 | 121 | Compressed range (35/60/80) |
| human-review | 62.6 | 16.2 | 64 | Problem cases (tend to be overridden downward) |

### Season Trends
Stable at 68-73 across all seasons 2005-2026. No concerning drift.

## Known Cosmetic Issues (Not Bugs)
- **1 score-thumb contradiction**: Cabaret 2014 — Adam Feldman scored 91 (from positive bwwExcerpt) but dtliThumb=Down (from different/older excerpt). Score is correct; dtli data is from a mismatched source.
- **5 LLM-scored reviews with no text or excerpt** — edge cases where the review file had content that was later cleaned. Scores may be stale.

## No Issues Found
- No score clustering (all same-score shows) with 5+ reviews
- No low-diversity shows (<=2 unique scores, 8+ reviews)
- All open/previews shows have scored reviews (only previews-status shows awaiting opening have none)
