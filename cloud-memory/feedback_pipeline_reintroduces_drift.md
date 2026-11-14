---
name: Pipeline re-introduces metadata drift
description: "Fix the source (collect-review-texts.js) alongside the data file."
type: feedback
archived: true
---

Data file fixes alone don't stick — the pipeline re-introduces drift on every CI run.

**Why:** collect-review-texts.js sets textStatus/textQuality/isFullReview during collection, but only synced textStatus for complete tier (and set it to 'full' not 'complete'). classifyContentTier only ran when fullText existed, so files with no fullText kept stale contentTier=complete.

**How to apply:** When fixing metadata inconsistencies in review-text files, always check whether the pipeline that writes those files will re-introduce the problem. Fix the pipeline source (collect-review-texts.js, rebuild-all-reviews.js) alongside the data fix. Also beware CI race conditions — data pushes can be overwritten within minutes.
