---
name: feedback_audience_buzz_roundup_megathread_contamination
description: "Generic/collision-prone show titles pull roundup/megathread Reddit comments into audience buzz; volume inflation, not score divergence"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 55f05cf5-3fed-416e-98d4-03fee1d473f3
---

Reddit audience-buzz (scrape-reddit-sentiment.js) searches r/Broadway by show
TITLE. For generic/collision-prone titles ("Music City", "Mercury", "Proof"),
the bare-phrase query matched recurring multi-show threads — "Drama Desk Awards
2025" (189 comments), "Theater Wrap", weekly threads — and harvested ALL their
comments. The buzz-classifier prompt explicitly told the LLM to assume an
ambiguous "I saw it" refers to the target show, so megathread comments about
other shows scored as the target's buzz. music-city-off-broadway-2026:
reddit rc=148 vs ShowScore 37/Mezz 21 → 72% volume weight → combinedScore 90.68
→ newsletter "Biggest Mover" (2026-06-15).

**Why:** combined score is volume-weighted, so contamination that inflates
Reddit VOLUME wrecks the score even when Reddit's score isn't far off the
others — which REDDIT_SCORE_DIVERGENCE (needs ≥2 other anchors + 40pt gap)
could never see. Sole-source OB shows (no ShowScore/Mezzanine) get 100% weight
from poisoned reddit.

**How to apply:** (1) Roundup/megathread posts must be excluded at post level
(isRoundupOrMegathread in reddit-post-filters.js) — audience analogue of
isRoundupArticle. (2) Never run a bare `"<title>"` Reddit query; market-anchor
it. (3) Cap comments-per-post so one thread can't dominate. (4) Detect
contamination by VOLUME ratio (reddit rc ≫ other sources) for generic titles,
not just score divergence — REDDIT_GENERIC_VOLUME_INFLATION in
audit-audience-buzz-contamination.js. (5) Neutralize live data with
reddit.suppressed (isRedditEligible skips it; self-clears on re-scrape) via
neutralize-contaminated-reddit-buzz.js. Links: [[feedback_audience_scrapers_share_normalize]].
