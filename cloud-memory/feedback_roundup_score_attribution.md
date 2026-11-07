---
name: Roundup/aggregator scores must not be attributed to listed outlets
description: "Never use aggregator stars as outlet originalScore; TR rates independently."
type: feedback
archived: true
---

Never use star ratings or explicit ratings from roundup/aggregator pages as an outlet's `originalScore`. Aggregators (theatre.reviews, WestEndTheatre, ShowScore) rate shows independently — their 3/5 is their opinion, not what Telegraph or BWW gave.

**Why:** Aggregator star ratings were stamped as outlet originalScores across 235+ reviews in ~60 shows. The auto-adjudicator then trusted these wrong ratings over correct LLM sentiment analysis. BWW Producers was scored 60 (from TR's 3/5) instead of 87 (correct LLM Rave).

**How to apply:**
1. Only trust `originalScore` from the outlet's own page (HTML extraction)
2. Aggregator ratings → metadata only (e.g., `theatreReviewsStars`, `wetStars`), never `originalScore`
3. The rebuild trusts `originalScore` at P0 priority ONLY when `scoreSource` is in `OUTLET_VERIFIED_SOURCES` (`scripts/lib/score-extractors.js`). Sources not in that set get downgraded to P3b.
4. **When adding a new score extractor:** add its `scoreSource` tag to `OUTLET_VERIFIED_SOURCES` in the same PR, or the rating will be silently ignored by the rebuild.
5. ShowScore stars are wrong ~11% of the time — never treat as outlet-verified.
