# BRO-4989 cost history and investor-return model: rollout and revert

## What is live today (shadow)

Nothing the site reads has changed. `modelRecoupmentPct`, `modelBreakeven`,
`weeklyRunningCost` and `designation` are still written by the old code paths.
The new code only produces a report:

| Piece | File | Writes |
|---|---|---|
| Dated cost anchors | `scripts/lib/cost-history.js` | nothing (pure) |
| Waltz history | `scripts/lib/waltz-cost-history.js`, `scripts/scrape-boring-waltz-costs.js` | `costHistory` only with `--record-history` (off in CI) |
| Cost index | `data/broadway-cost-index.json` | n/a (data) |
| One cost function | `scripts/lib/cost-for-week.js` | nothing (pure) |
| Investor multiple | `scripts/lib/investor-return-model.js` | nothing (pure) |
| Designation rule | `scripts/lib/designation-rule.js` | nothing (pure) |
| Shadow diff | `scripts/shadow-investor-model.js --out=FILE --golden` | the `--out` file only |
| Backtest | `scripts/backtest-cost-index.js` | nothing; exit 2 if median error > 15% |
| Weekly checks | `scripts/check-cost-anchors.js [--queue]` | research queue (max 3 per run) with `--queue` |
| Seed anchors | `data/cost-anchor-seeds.json` | n/a (data, every row sourced) |

`recoupment-model.js` gained exports only; `calculateRecoupment` and
`calculateLifetimeRecoupment` give identical output to main on all 232 shows
checked.

## Revert (one step)

Shadow phase: `git revert <merge commit of land/bro-4989-cost-history>`. No
live field depends on these files, so nothing else needs undoing.

After the live switch (not done yet): the switch writes the new fields next
to the old ones (`investorMultiple*`, `costHistory`) and keeps the old fields
for two weekly cycles. To revert, set the consumers back to the old fields
(one commit, listed in the switch PR) and leave the new fields in place; they
are ignored by everything else. Designation changes go through
`commercial-pending-fixes` with evidence, so each can be reverted in the same
queue.

## Before the switch

1. BRO-4985 merged and this branch rebased onto it.
2. `node scripts/shadow-investor-model.js --golden` exits 0 on the rebased data.
3. `node scripts/backtest-cost-index.js` exits 0.
4. The before/after summary sent to the review session and its reply received.
