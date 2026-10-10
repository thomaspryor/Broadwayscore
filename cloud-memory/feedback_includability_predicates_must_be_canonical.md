---
name: Bespoke includability predicates drift from canonical — always delegate to isIncludableForRebuild
description: New scripts that gate on review-includability flags must call isIncludableForRebuild from review-guards.js, not list flags themselves. Bespoke predicates silently miss stale-flag overrides (wrongShowCleared, fullTextWrongAuthor + excerpt, isLikelyStaleRoundupFlag). Caught 2026-04-28 Codex round-1 P0.
type: feedback
originSessionId: 4a88f5bf-d40d-4933-882a-0b534879c331
---
**Rule:** Any new script that gates on review-text includability flags MUST call `isIncludableForRebuild(data, show)` from `scripts/lib/review-guards.js:1711`. Do not list flags inline. Do not write a bespoke predicate.

**Why:** The canonical predicate has 18 nuanced checks including stale-flag overrides:
- `wrongProduction` allows 3 manual-clear paths (`wrongProductionManualClear`, `wrongProductionOverride`, `humanReviewedWrongProduction === false`)
- `wrongShow` allows `wrongShowCleared()` + `isLikelyStaleWrongShow()` overrides
- `isRoundupArticle` allows `isLikelyStaleRoundupFlag()` override
- `fullTextWrongAuthor` allows excerpt-only inclusion (any of 6 excerpt fields)
- `contentTier='invalid'` allows wpCleared override
- `rejectedAt` allows `textFetchedAt > rejectedAt` re-fetch + wpCleared exceptions

A bespoke "skip if wrongShow=true" predicate misses cleared/stale flags and produces false negatives — cohort silently differs from rebuild.

**How to apply:**
```js
const { isIncludableForRebuild } = require('./lib/review-guards');
function isScoreableSurvivor(data, show) {
  if (!isIncludableForRebuild(data, show || {})) return { eligible: false };
  return { eligible: true };
}
```

If you genuinely need a STRICTER predicate (e.g., extra LLM-only filters), DELEGATE to `isIncludableForRebuild` first, then add explicit comments for each extra exclusion (`// LLM-ONLY: scraper_garbage`).

**Caught:** 2026-04-28 round-1 ship-check on `verify-all-scored.js`. Initial commit reimplemented exclusion flags inline. Codex flagged drift: missed `wrongShowCleared` override + `fullTextWrongAuthor + stagedoorExcerpt` inclusion case. Refactor to delegation eliminated the drift class.

**Known active drift (P1 follow-up):** `scripts/llm-scoring/is-scoreable.ts` and its JS mirror `scripts/lib/is-scoreable.js` have 14 confirmed divergences from `isIncludableForRebuild` — 10 LLM-more-permissive (wasted credits), 2 LLM-more-restrictive (orphan-unscored class). Notion card `34f637c5-416f-810d-84a6-da8dd3bbbccc` has the hardened plan (Codex-second-opinion-validated, two-PR split).
