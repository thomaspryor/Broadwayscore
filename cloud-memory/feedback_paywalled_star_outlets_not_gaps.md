---
name: paywalled-star-outlets-not-gaps
description: Paywalled star-rating outlets (The Stage) ARE scored via aggregatorStars-fallback even as stubs — empty stubs are not review gaps; gap-scans must exclude _pending/ and count aggregatorStars
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 052a6222-8014-4e17-bd87-e77b97a81b3f
---

When auditing for "missing/unscored reviews," a review-text file that is a `stub`
(fullText null, `originalScore: null`) is NOT necessarily a gap.

**Why:** Paywalled star-rating outlets — The Stage (`thestage`), and other UK
stars/5 outlets — have their star rating extracted by `extractUKStarRating`
(`scripts/lib/score-extractors.js`, handles `stageStar.svg`/`stageNoStar.svg`)
into the **`aggregatorStars` / `aggregatorStarsNormalized`** fields, NOT
`originalScore`. `rebuild-all-reviews.js` then scores them via the
`aggregatorStars-fallback` path. So a Stage review with `fullText: null`,
`contentTier: "stub"`, `originalScore: null` but `aggregatorStarsNormalized: 80`
**is fully scored and live in reviews.json** (verified 2026-05-29: 177/177
thestage reviews scored). The paywalled body is irrelevant — the 4/5 star
rating is ground truth.

**How to apply:** Before claiming an outlet is "suffering like 1minutecritic"
(free site, body-in-HTML, missing extractor pattern → unscored stub), run a
gap-scan that:
  1. **Excludes `_pending/`** — that dir is quarantine (misrouted/paywall-failed
     duplicates; e.g. the same `beaches-review-broadway.html` filed under 4
     unrelated OB show dirs, plus film URLs like `/movies/is-god-is-review`).
     Files there are already out of the pipeline and not in reviews.json.
  2. **Counts a review as scored** if ANY of `originalScore`, `aggregatorStars`,
     `assignedScore`, `normalizedScore` is non-null — not just fullText+originalScore.

A 2026-05-29 scan that ignored both rules falsely flagged The Stage (40 "stubs"),
pages-on-stages (0 files — phantom), NYT (115) and Variety (40) as gaps. After
applying the rules: The Stage is fully scored, pages-on-stages doesn't exist,
and the NYT/Variety hits were all `_pending/` quarantine noise. There were NO
other outlets with the genuine 1minutecritic-class problem — that fix set
([[content_quality_regex_fps]]-adjacent, 1mc + TheaterMania extractor patterns)
was complete. Hard-paywalled prose outlets (NYT, Variety) without a star rating
are a separate class (need Browserbase/manual, see [[wsj-newyorker-ci-ip-block]]),
not a fixable extractor gap.
