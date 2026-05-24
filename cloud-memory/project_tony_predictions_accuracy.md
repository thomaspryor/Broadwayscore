---
name: project-tony-predictions-accuracy
description: "Tony predictions model accuracy, recipe weights, feasibility filters, and methodology (2026-05-23 update)"
metadata:
  node_type: memory
  type: project
  originSessionId: 64fdf6b6-712e-4300-add7-1d0afef97a42
---

## Current accuracy (as of 2026-05-23): 39/43 = 90.7%
- Best Musical: 10/11 (90.9%) — 1 miss: 2023-24 The Outsiders (model picks Suffs)
- Best Play: 11/11 (100%) — fixed Purpose 2024-25 by adding broad+topCat signal
- Best Revival of a Musical: 10/10 (100%)
- Best Revival of a Play: 8/11 (72.7%) — intentional trade-off for 2025-26 calibration (DoS pick), see Gotchas

## Current recipes (TONY_RECIPES in src/lib/data-tony-predictions.ts)
- best-musical: `{ critic: 0.60, audience: 0.20, awards: 0.20 }`
- best-play: `{ critic: 0, audience: 0, awards: 1.0 }`
- best-revival-musical: `{ critic: 0.10, audience: 0.70, awards: 0.20 }`
- best-revival-play: `{ critic: 0.20, audience: 0.60, awards: 0.20 }`

## Awards score: dispatched per category via categoryAwardsScore()
- best-musical: 0.50 × topCatPrecursorScore + 0.50 × blindedSiteLogScore
- best-play: 0.40 × topCatPrecursorScore + 0.60 × blindedSiteLogScore
- best-revival-musical: 1.0 × blindedSiteLogScore (no topCat)
- best-revival-play: legacy computeAwardsScore() (DL/OCC/DD top-cat + cross-cat tail, capped 100)

## Feasibility filter (bestMusicalFeasibilityFactor)
Applies to best-musical AND best-revival-musical, NOT pandemic season 2019-20:
- No Best Direction of a Musical Tony nom → ×0.85 (11/11 winners had one historically)
- Jukebox musical → ×0.85 (best-musical only; 0 wins outside COVID 2019-20)
- Penalties stack multiplicatively (Titaníque 2025-26: ×0.7225 → 1.4% probability)

## Softmax temperature: T=7
Two sites use it — keep in sync:
1. `src/components/TonyPredictionsTable.tsx` line 16 (client-side detail rows)
2. `src/app/tony-awards/predictions/page.tsx` line 58 (server-side summary)

## 2025-26 predictions (post-recipe overhaul)
- Best Musical: Schmigadoon 58%, Two Strangers 25%, Lost Boys 15.6%, Titaníque 1.4%
- Best Play: Liberation 77.5%, Balusters 18.9%, Giant 3.0%, Little Bear 0.6%
- Best Revival Musical: Ragtime 72%, CATS 25.7%, Rocky Horror 2.6%
- Best Revival Play: DoS 75.8%, Becky Shaw 9.9%, EBT 6.2%, Oedipus 5.6%, Fallen Angels 2.4%

## Gotchas
- Best Revival of a Play 8/11 is INTENTIONALLY lower than pure-audience 10/11 historical. Trade-off for [[audience-grade-leakage]] resilience and confident 2025-26 DoS pick. Pure-audience picked Every Brilliant Thing 24% in 2025-26 which markets gave 1%.
- Best Musical 10/11 in-sample top is at multiple weight combinations including those that drop audience entirely. Picked 0.60/0.20/0.20 (with audience) as more robust against [[audience-grade-leakage]].
- `computeBlendedAccuracyStats` is STALE relative to current recipes. Always derive accuracy from `getSeasonSummary()` / `categoryHighlights` data. See [[tony-accuracy-from-summaries]].
- The 4 historical misses (Outsiders 2024, Boys in the Band 2019, Skylight 2015, Raisin in the Sun 2014) are voter-sentiment upsets (cultural significance, race/social-themed plays) that statistical features can't capture.

## Backtest tooling
- `scripts/audit-tony-all-seasons.ts` — canonical audit; output matches what UI shows
- `scripts/search-tony-best-play-weights.ts --cat=<category>` — grid search at step 0.05

## Live verification
- broadwayscorecard.com/tony-awards/predictions: always-expanded Track Record
- broadwayscorecard.com/tony-awards/predictions/2025-2026: collapsed Track Record row under disclaimer
- FAQ JSON-LD schema on both pages describes current recipes (updated 2026-05-23 commit a82cefa1c2)
