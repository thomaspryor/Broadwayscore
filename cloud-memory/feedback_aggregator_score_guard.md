---
name: Aggregator score guard must be in ALL extraction scripts
description: "Every extractor must check AGGREGATOR_SCORE_SOURCES before writing originalScore."
type: feedback
originSessionId: 856d369e-bd09-476d-abdf-06e8655672b3
archived: true
---
Any script that extracts scores from HTML (via score-extractors.js) and writes `data.originalScore = result.originalScore` MUST check `AGGREGATOR_SCORE_SOURCES.has(result.source)` first. If true, write to `data.aggregatorStars` instead.

**Why:** score-extractors.js returns sources like `lbo-css-stars`, `stagedoor-star-rating`, etc. These are aggregator ratings, not outlet-direct scores. 8 scripts had this bug: gather-reviews, recover-explicit-ratings, recollect-for-scores, extract-explicit-ratings, extract-scores-from-archives, extract-we-star-ratings, retry-pending-scores, verify-showscore-stars. All fixed 2026-04-06.

**How to apply:** When adding new score extraction scripts or modifying existing ones, import `AGGREGATOR_SCORE_SOURCES` from `review-normalization.js` and add the guard. The pattern:
```js
if (AGGREGATOR_SCORE_SOURCES.has(result.source)) {
  data.aggregatorStars = result.originalScore;
} else {
  data.originalScore = result.originalScore;
}
```

**2026-04-10 update:** After the 8-script fix sweep, contamination kept appearing on WE shows (5 files in one Weekly Refresh run). The actual writer is still in the codebase — defense-in-depth was added to `rebuild-all-reviews.js` (around line 1696) that auto-migrates `originalScore` + aggregator `scoreSource` → `aggregatorStars` on every rebuild, tracked via `stats.migratedAggregatorScore`. This catches the symptom but root cause hunt is unfinished — see Notion card "Find actual writer of show-score-stars to outlet originalScore". Suspected: convert-show-score, scrape-showscore-we, gather-reviews mergeReviews. The bug appears when multiple writers touch the same file across pipeline steps, leaving originalScore from one writer + scoreSource from another.
