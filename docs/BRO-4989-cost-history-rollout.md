# BRO-4989 cost history and investor-return model: rollout and revert

Current status, checked 2026-10-25: BRO-5598 has since enabled `datedCosts` for
musicals. The shadow-only description below records the original rollout. The
BRO-5018 evidence requirement and its unresolved policy conflict are detailed
in the dated research update at the end of this document.

## Initial BRO-4989 shadow rollout (historical snapshot)

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

## BRO-5018 dated cost anchor research

Research date: 2026-10-25. **Incomplete: 8 pairs, with 22 still missing.**

| Earlier observation's era | Before | After | Still needed | Median absolute index error |
| --- | ---: | ---: | ---: | ---: |
| pre-2010 | 1 | 3 | 7 | 13.7% |
| 2010-2019 | 1 | 3 | 7 | 11.6% |
| 2020+ | 1 | 2 | 8 | 7.9% |

The overall sourced-ledger median absolute error is 11.2%. These small samples
cannot establish the index's accuracy. Five new capitalization comparisons join
the three existing running-cost comparisons. Capitalization budget revisions,
especially during development delays, are different from annual running-cost
inflation. The report exposes errors for each kind separately. No commercial
records, cost history, cost index, recoupment options or model inputs changed.

### Completion check

Run both commands:

```sh
node --test tests/unit/cost-anchor-ledger.test.mjs
node scripts/backtest-cost-index.js
```

The first command validates evidence and boundary behavior. It already passed on
the supplied main checkout with only three ledger records, so it is not a
completion gate. The second is the existing coverage gate: it exits 2 until
every era has at least ten pairs, and also checks index error. On this ledger
it still exits 2 for incomplete coverage. It must be included alongside the
card's VERIFY command before claiming the research is complete. Do not make the
schema test fail permanently while the research remains incomplete.

After sufficient coverage, also run:

```sh
node scripts/backtest-recoupment-ground-truth.js --opt=datedCosts
```

Coverage and index fit alone do not authorize promotion. The checker's remaining
conditions are no category worse and no new false recouped result.

### Added observations

All amounts below are USD. Each pair is in `data/cost-anchor-ledger.json` with
both URLs, trade source classifications, publication dates, cost date bases and
paraphrased provenance notes. Dates and amounts come from article text, not URLs.
Playbill observations were verified in indexed article text; direct page opens
returned HTTP 403. Pollstar and Broadway Journal pages were readable directly.

| Production | Earlier capitalization | Later capitalization | Signed index error |
| --- | --- | --- | ---: |
| Spider-Man | 2009-08-14: $35M | 2010-05-18: $50M | -28.4% |
| Spider-Man | 2010-05-18: $50M | 2010-10-29: $65M | -22.0% |
| Spider-Man | 2010-10-29: $65M | 2011-06-28: $75M | -11.6% |
| Cabaret (2024) | 2023-09-20: $24.25M preliminary budget | 2025-09-21: $24.25M final reported capitalization | +7.1% |
| Dance of the Vampires | 2001-10-05: $10M | 2003-01-14: $12M | -13.7% |

Spider-Man uses adjacent revisions, without counting all combinations of its four
observations. These are three intervals for one production, not three independent
productions. Sources: Playbill's [August 2009 budget](https://playbill.com/article/playbillcoms-theatre-week-in-review-aug-8-14-web-of-intrigue-com-163558),
[May 2010 production estimate](https://playbill.com/article/julie-taymor-talks-spider-man-com-191230),
[October 2010 budget](https://playbill.com/article/spider-man-actor-kevin-aubin-injured-at-group-sales-event-com-173166),
and Pollstar's [June 2011 financial-statement report](https://news.pollstar.com/2011/06/28/calculating-spider-man-costs/).

Cabaret compares the [preliminary full budget](https://www.broadwayjournal.com/p/cabaret-at-24-million-is-broadways-costliest-revival-exclusive)
with [final reported capitalization after closing](https://www.broadwayjournal.com/p/cabaret-producers-investor-tried-to-extort-us).
The latter was published September 25, 2025 and identifies the preceding Sunday
as closing. Its cost date uses that period end. This does not imply new spending
at closing. The $20.9M recoupment basis excludes reserves, deposits and advances;
it is not comparable to the full $24.25M budget. The separate $26M maximum
offering is a bound and was not entered as an actual cost.

Dance of the Vampires compares the [Broadway budget before rehearsals](https://playbill.com/article/dance-of-the-vampires-wont-reach-minskoff-till-oct-2002-com-98991)
with [mounted capitalization at the closing announcement](https://playbill.com/article/dance-of-the-vampires-to-close-on-broadway-jan-25-com-111015).
The earlier article also gives a Vienna budget; that separate production is
excluded. Both observations use their contemporary report dates.

### Rechecked leads that do not supply another pair

* **Hamilton 2017 to April 2018:** the [April 25, 2018 report](https://www.broadwayjournal.com/p/hamilton-inc-update-creators-producers-clean-up-as-muzzled-cast-waits-for-it)
  describes the year ended July 2017. It is already the later observation in
  the existing pair, not a new 2018 cost. The current commercial record also
  describes that same $643,000 annual average.
* **Water for Elephants November 2023 to March 2024:** the
  [November 6, 2023 report](https://www.broadwayjournal.com/p/inside-broadways-1-million-nut-cases)
  quotes one budget prepared the preceding summer for the upcoming opening.
  The seeds and commercial cost history reuse it. Its $960,000 amount is
  gross box-office breakeven including fees, not fixed running expenses.
  The later cost-history figures are Reddit estimates and cannot complete it.
* **Spider-Man 2011 to 2013 running costs:** the [2013 closing report](https://playbill.com/article/broadways-spider-man-turn-off-the-dark-will-have-lost-nearly-60-million-by-closing-date-com-211971)
  supplies a lower bound, not another point observation. Retain it only in the
  existing exploratory backtest's floor checks.
* **Phantom's $610,000 statistic:** the [2006 Philadelphia article](https://www.broadwayworld.com/philadelphia/article/Phantom-of-the-Opera-Still-a-Philly-Phavorite-20061201)
  credits touring material from October 2005. A [Houston report](https://www.chron.com/culture/main/article/phantom-of-the-opera-s-return-to-houston-opens-1605133.php)
  explicitly labels that amount as the current tour's cost. It cannot be
  paired with the Broadway production's costs.
* **Operation Mincemeat:** the previously suggested $14.5M maximum versus
  $11.5M actual comparison still needs a dated, comparable point budget on
  the first side. A maximum raise is not an actual cost observation.

### Caller, existing fix and remaining decision

`scripts/backtest-cost-index.js` imports `loadLedger()` and `evaluateLedger()`
from `scripts/lib/cost-anchor-ledger.js`. That loader reads the manually curated
ledger directly. The same backtest separately calls `loadSeries()` in
`scripts/lib/cost-index-backtest.js`, which reads seeds and commercial cost
histories. Those histories include estimates, explaining why its 1,317 point
pairs do not satisfy this research requirement. Its exploratory 0.1% median
absolute error is unchanged by the ledger additions.

The existing validator, acceptance tests and coverage-aware backtest are already
present on main. This change extends the source evidence rather than rewriting
those working paths. It adds no scripts, flags, functions, scheduled jobs, paid
fetches, LLM calls or runtime API calls.

BRO-5598 already enables `datedCosts` in `MUSICAL_LIVE_OPTS` in
`scripts/lib/recoupment-model.js`. This conflicts with this card's shadow-only
rule. Resolving the conflict requires the owner or checker decision identified
in the card comments. No live settings were changed here. Further research is
still required for seven pre-2010 pairs, seven 2010-2019 pairs and eight 2020+
pairs; no unverified leads or repeated publication dates were counted to fill
those gaps.
