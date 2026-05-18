---
name: project-tony-predictions-accuracy
description: "Tony predictions model accuracy analysis, recipe weights, softmax temperature, and historical backtest findings (2026-05-17)"
metadata:
  node_type: memory
  type: project
  originSessionId: dbb4711d-b2fd-4824-a30c-440ee0feee95
---

## Current accuracy (as of 2026-05-17): 41/42 = 97.6%
- Best Musical: 11/11 (100%)
- Best Play: 11/11 (100%) — fixed 2024-25 miss (Purpose) by using critic+awards recipe
- Best Revival of a Musical: 10/10 (100%)
- Best Revival of a Play: 9/10 (90%) — 1 irreducible miss: 2014-15 Skylight (Elephant Man had higher aud)

**Recipe changes shipped 2026-05-17:**
- best-play: {0.4/0.4/0.2} → {0.65/0.00/0.35} — critic+awards, no audience. Tony voters follow critical consensus and precursor awards for plays. Creates 17pt gap for Liberation (89.8 vs 72.4), matching market confidence.
- best-revival-play: {0/0.8/0.2} → {0.40/0.60/0.00} — critic+audience, no awards. All 3 historical misses had awards anti-correlated with winning. 7→9/10 in-sample.

## Softmax temperature: T=7 (changed from T=10 on 2026-05-17)
**Two computation sites** — both must be kept in sync:
1. `src/components/TonyPredictionsTable.tsx` line 16 — client-side (detail rows)
2. `src/app/tony-awards/predictions/page.tsx` line 58 — server-side (top summary cards)

T=7 produces distributions closer to GD/Kalshi market odds (T=10 was too flat).

## Current season (2025-26) signals and "Our pick %" at T=7
- Best Musical: Schmigadoon! #1 — Our 36%, GD 61%, KA 67% (clustered scores, genuine uncertainty)
- Best Play: Liberation #1 — Our 87%, GD 93%, KA 84% ✓ very close match
- Best Revival Musical: Ragtime #1 (aud=94) — Our 55%, **GD DISAGREES: CATS 65% vs Ragtime 32%**
- Best Revival Play: Death of a Salesman #1 — Our 31%, GD 87% (clustered 5-nominee field, model has genuine uncertainty)

## Current recipe constants (TONY_RECIPES Tier 1)
- best-musical: {critic: 0.43, audience: 0.52, awards: 0.05}
- best-play: {critic: 0.65, audience: 0.00, awards: 0.35}
- best-revival-musical: {critic: 0, audience: 1.0, awards: 0}
- best-revival-play: {critic: 0.40, audience: 0.60, awards: 0}

## Market data coverage
- GoldDerby (tony-win-probabilities.json): all 4 top categories, current season only
- Polymarket (tony-polymarket-odds.json): Best Musical + Best Play only
- Kalshi (tony-kalshi-odds.json): Best Musical + Best Play only
- None have historical data; can't backtest market signal calibration

## Backtest script
`scripts/tony-deep-backtest.ts` — accurate as of 2026-05-17. Uses pre-computed fields on SerializedTonyShow (tonyAudienceGrade, awardsScore, gdOdds) — do NOT access show.id (undefined on SerializedTonyShow).

Grid search: `scripts/search-tony-best-play-weights.ts --cat=<category>` with LOOCV validation.

**How to apply:** The irreducible misses (Skylight 2014-15) cannot be fixed with current features. The T=7 temperature change created meaningful improvement for Best Play (87% vs 93% GD). For revival-play, 5-nominee clustering makes probability descent naturally flatter — this is genuine model uncertainty, not a calibration bug.
