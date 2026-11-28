---
name: rebuild contentTier safety-net runs BEFORE wrongProduction auto-clears
description: rebuild-all-reviews.js classifies contentTier at line 1487, but auto-clears wrongProduction at lines 1667/1833/1849/2039. Order matters — gate inside classifyContentTier on cleared-state flags.
type: feedback
originSessionId: 54f662de-dd33-4644-9d1d-ea9fb9fbd62f
archived: true
---
The rebuild's contentTier safety-net at `rebuild-all-reviews.js:1487` calls `classifyContentTier(data)` BEFORE the wrongProduction auto-clears at lines 1667 / 1833 / 1849 / 1861 / 1866 / 2039. Reviews where an early guard sets `wrongProduction=true` (pre-opening, cross-market, OB→Broadway transfer) but a later auto-clear flips it back (allowEarlyDate, allowCrossMarket, etc.) get stuck with stale `contentTier='invalid'` written to disk. The classifier never re-runs.

**Why:** Manually flipping contentTier in the private repo (e.g. via `reclassify-invalid-reviews.js --apply`) is unstable — the next rebuild re-reads `wrongProduction=true` from in-memory state at line 1487 and writes `contentTier='invalid'` back. Fix-and-commit-data won't survive a single rebuild cycle.

**How to apply:** When `classifyContentTier` needs to predict the post-auto-clear state, gate on the standard clear-signaling flags directly inside the classifier:
```js
const effectivelyWrongProduction = review.wrongProduction
  && !review.allowEarlyDate
  && !review.allowCrossMarket
  && !review.wrongProductionManualClear
  && !review.wrongProductionCleared
  && !review.wrongProductionAutoCleared
  && review.humanReviewedWrongProduction !== false;
```

Don't try to reorder the rebuild's per-file loop — wrongProduction is set/cleared in many places (lines 989, 1047, 1258, 1739, 1992, 2008, 2062, 2093, 2119, 2130, 2161, 2468). Predicting the cleared state at the classifier is far simpler.

**Related discovery:** `classifyContentTier` did NOT gate on `wrongShow` either — wrongShow=true reviews could flip to `complete`/`truncated`/`excerpt` based on text length alone. Added `effectivelyWrongShow = review.wrongShow && !review.wrongShowManualClear` in the same gate.

**Found 2026-04-25** while completing card 34c637c5-416f-817b. First rebuild after a 12-review backfill reverted 11 of 12 flips. Fix in commit `c0c0f05572`. Companion fix to push-review-texts/action.yml in `0052f4474f` (incompleteReason cleared by rebuild was being restored on push).

**Don't:** patch the data files. Patch the classifier so the data can correct itself on the next rebuild cycle.
