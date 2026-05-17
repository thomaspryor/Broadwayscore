---
name: Percentage rounding absorb-into-last-term is a bug
description: "Never compute last pct as 100-a-b-c; use Hamilton largest-remainder."
type: feedback
originSessionId: 7abba0e9-5567-4883-b414-562f6136cd37
archived: true
---
When allocating percentages across N tiers/buckets for a visual display (bar chart segments, pie slices), never compute the last value as `last = 100 - a - b - c`. That pattern forces one segment to absorb all the compound rounding error, which causes two bugs:

1. **Ghost slivers**: if rounding happens to leave +1, the "absorbing" segment renders a 1% chunk even when its count is zero. Production example: hamilton-2015 with counts 38/3/1/0 produced percentages 90/7/2/**1** and rendered a 1% red sliver for "Negative" with zero negative reviews. 14 live broadwayscorecard.com shows had this bug simultaneously on 2026-04-11 before the fix.

2. **Negative percentages / shortened bars**: if rounding goes the other way, the absorbing segment becomes -1, which the render guard hides — but now the bar is only 99% wide. jitney-2017 example: 23/20/4/0 → 49/43/9/**−1** → visible bar is 49+43+9 = 101% and gets clipped on the right with `overflow-hidden`.

**Why:** Use Hamilton's largest-remainder method. Floor every percentage, compute the remainder (100 − sumOfFloors), then distribute +1 bumps to the tiers with the largest fractional parts first. Zero-count tiers must be skipped from bump distribution (their exact is 0, fraction is 0, so they sort to the bottom naturally — but add an explicit guard anyway because remainder could be exactly equal to sum of non-zero-count slots).

**How to apply:** For any component showing a distribution as a horizontal stacked bar (breakdown bars, progress bars, split meters), use largest-remainder allocation AND gate the render on `count > 0`, not on `percentage > 0`. The count is the source of truth — the percentage is a derived display value.

**Canonical implementation:** see `src/components/show-cards/ScoreBreakdownBar.tsx` → `allocatePercentages()`. Regression tests in `tests/unit/score-breakdown-tier.test.ts` include the Hamilton + Jitney cases and a data-driven sweep over all 1,470+ public show JSONs asserting sum=100 and no-ghost-sliver invariants.
