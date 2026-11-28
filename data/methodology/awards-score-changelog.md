# Awards Score Changelog

The Awards Score quantifies precursor-award signal for the Tony Predictions model. It combines Drama League (weight 1.0), Outer Critics Circle (0.9), and Drama Desk (0.7), with a tier-weighted bonus per category.

## 2026-05-16 — Tier-weighted noms

**What changed.** Replaced the legacy "every nomination counts the same" formula with a tier-weighted one. Each non-top-category nomination is now credited by category importance:

| Tier | Categories | Weight |
|------|------------|--------|
| S | Best Musical / Play / Revival (top cat) | counted via +30 win / +10 nom bonus, then 0 in noms tail |
| A+ | Book, Music, Lyrics, Score | 2.0 |
| A | Direction, Lead Acting, Choreography | 1.5 |
| B | Featured Acting, Orchestrations | 1.0 |
| C | Set / Costume / Lighting / Sound Design | 0.5 |

**Why.** A Direction win at Drama Desk is a stronger Tony signal than a Lighting Design nomination — the old "count = 1 per nom, cap at 25" formula treated them equivalently and saturated quickly. Tier weights restore the signal.

**Data added.** Per-category nomination backfill for the 2022-23, 2023-24, and 2024-25 ceremonies covering DD Tier 2/3 categories and DL Direction (89th/90th/91st).

**Backtest result.** Across 11 years of Tony history (43 contests pre-change, 42 post-data-revisions), the predictions model picked the correct winner in **39 of 42** contests (was 41 of 43). The one regression: Best Play 2024-25 flips from *Purpose* (actual Tony winner) to *John Proctor is the Villain* by 0.3 composite points. JP was more decorated at precursors (OCC top-cat + DD Direction win); Tony voters chose Purpose. This is a known critic-vs-voter split — the model correctly amplifies the precursor signal, and we accept the one-contest regression.

**Score range.** Across nominees with any precursor signal: 0–100 (mean of nonzero ≈ 32). Sweepers (Maybe Happy Ending, Stereophonic) score 90+; multi-category nominees with one or two precursor wins score 30–70; single-nomination shows score 5–20.

**Files.**
- `src/lib/data-tony-predictions.ts` — `computeAwardsScore` rewritten.
- `src/lib/awards-scoring.ts` — `classifyCategory` exported and reused.
- `data/precursors/drama-desk.json`, `data/precursors/drama-league.json` — backfilled.
- `scripts/derive-noms-pool-ceilings.js` — kept in lockstep with the live classifier.

**Known follow-ups (tracked in Notion).**
- Hamilton's 2014-15 OCC season was Off-Broadway; the scorer doesn't credit OB-year precursor wins toward the Broadway transfer, so Hamilton scores 75 instead of ~95. Tracked: `362637c5-416f-810d-8749-dbd343dcf0b0`.
- Pre-2025 OCC and DD per-category backfill (covering the full 11-year backtest window) is partially shipped in a parallel session.
