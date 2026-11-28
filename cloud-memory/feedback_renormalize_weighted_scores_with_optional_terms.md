---
name: Renormalize weighted scores when an optional term defaults to 0
description: When a weighted scoring formula has a term whose value is 0 because data hasn't arrived yet, the formula score gets compressed by the missing-weight ratio, then visibly jumps when data lands. Drop the term and renormalize remaining weights — gate on the VALUE not the recipe weight.
type: feedback
originSessionId: 66fe2dde-3129-4b57-83b6-1c52c5414cdd
archived: true
---
When a weighted formula like `0.4*A + 0.4*B + 0.2*C` has a term whose value defaults to 0 (because the data hasn't arrived yet — e.g. precursor noms pre-announcement), the formula score gets compressed by the weight ratio. Pre-data, the result is `0.4A + 0.4B + 0` = 80% of the true 50/50 average of A and B. The day the data lands, every score visibly jumps ~10 points. Users notice. Rankings stay the same so unit tests pass.

**Why:** Caught by /ship-check on Tony predictor 2026-04-29. Best Play recipe was `0.4 critic + 0.4 audience + 0.2 awards`. Pre-precursor (Awards = 0 for everyone), every Best Play scored 0.4c + 0.4a — relative ranking matched 50/50 but absolute number was 80% of it. Comment in code claimed "naturally reduces to 50/50" — false. Fix: gate on the VALUE not the recipe weight; drop the component when value is 0; renormalize remaining weights to sum to 1.

**How to apply:** Whenever you write `if (recipe.weight > 0) push(component)`, ask: can the component's VALUE legitimately be 0 with no data? If yes, also gate on `value > 0` (or `value != null`) and renormalize. The bug shape: unit tests pass because relative ordering is preserved; users see ~10pt score jumps on a single deploy or data load.
