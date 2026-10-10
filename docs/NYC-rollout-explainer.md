# NYC anchored-bands + V6 decompression rollout — completion phase (BRO-217 / BRO-24)

Engineering record of the Phase 2 completion for the NYC (Broadway + Off-Broadway)
anchored-scoring rollout. This is the internal completion doc the card asked for —
it is not the public-facing explainer, which the owner decided not to publish
(see "Public explainer decision" below).

## What shipped

- **2026-07-20**: `broadway` and `off-broadway` added to `ANCHORED_MARKETS`
  (`src/config/scoring.ts` / `src/config/ANCHORED_MARKETS_NYC_V6.ts`), mirrored
  in `scripts/lib/star-reliability.js`. 16,462 reviews flagged for rescore via
  the `late-star-anchor` + `bw-v6-decompression` drain scripts.
- **edd60c7c1f7**: extracted the NYC market set to its own config file
  (`src/config/ANCHORED_MARKETS_NYC_V6.ts`) for isolated rollout history.
- **78629ee1b9b**: added a test guarding the `ANCHORED_MARKETS` TS/JS mirror
  against silent drift between `scoring.ts` and `star-reliability.js`.
- **2026-08-18**: rescore drain confirmed empty (`needsRescore` total = 0
  corpus-wide); rebuild + prod deploy happened automatically on the standing
  cron, no manual trigger needed.

## Verification (this session, 2026-08-26)

- `needsRescore` count across the live `data/reviews.json`: **0** (both NYC
  markets and corpus-wide). Drain is fully drained, not just quiet.
- `node scripts/audit-star-accuracy.js`: **0 HARD conversion bugs, 0 SUSPECT
  captures** across 2,920 shows.
- Both the config commit (`edd60c7c1f7`) and the drift-guard test
  (`78629ee1b9b`) are ancestors of the current production deployment — the
  anchored-bands code path for Broadway/Off-Broadway is live, not just merged.

## Public explainer decision

Owner decision 2026-07-26, reconfirmed 2026-08-13: **no public explainer**.
The July 11 plan predicted a mean composite lift of +1.6 for open NYC shows;
the actual measured outcome was +0.30 (58 open shows: 21 unchanged, 21 moved
1 point, 16 moved 2+). Marquee shows barely moved (Hamilton 91→91). A
composite is a tier-weighted average across 40+ critics, so lifting a
compressed ceiling on a handful of top-end reviews shifts the average by a
fraction of a point — not enough to justify a public announcement that
invites scrutiny without delivering news.

Full numbers, per-show deltas, and the prepared answer for inbound questions
(e.g. Wicked 67→63, which is an unrelated review-exclusion fix, not caused by
this rollout) live in the internal reference note:
`~/Documents/claude-outputs/nyc-rollout-explainer-draft-2026-07-26.md`.

## Status

Rollout complete. Drain drained, rebuild deployed, verification clean, no
further action needed. Comparative within-show scoring and tier-weight
changes were both considered and rejected on 2026-07-26 — do not re-propose
without new evidence.
