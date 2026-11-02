# BRO-4989 cost history and investor-return model: rollout and revert

Current status, checked 2026-11-02: BRO-5598 has since enabled `datedCosts` for
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

## BRO-5018 research update, November 2

**Incomplete: 12 pairs, with 18 still missing.** Two reported capitalization
comparisons were added to `data/cost-anchor-ledger.json`. All ten prior records
are unchanged. No commercial records, model inputs, index values or live
options were modified.

| Earlier observation's era | Before | After | Still needed | Median absolute index error, before / after |
| --- | ---: | ---: | ---: | ---: |
| pre-2010 | 4 | 5 | 5 | 21.0% / 13.7% |
| 2010-2019 | 4 | 4 | 6 | 9.1% / 9.1% |
| 2020+ | 2 | 3 | 7 | 7.9% / 8.6% |

The overall median absolute error moves from 11.2% to 9.8%. The existing
per-era index check now passes, but coverage still fails. These small samples
do not establish index accuracy. In particular, pre-2010 capitalization alone
still has a 21.0% median absolute error; its pooled era median is lower because
it also includes the existing Phantom running-cost comparison.

### Added evidence and limitations

* **Sunset Boulevard (1994):** [producer budget](https://www.latimes.com/archives/la-xpm-1994-04-24-ca-49624-story.html)
  to [retrospectively reported original cost](https://www.broadwayjournal.com/p/sunset-boulevard-storms-the-palace-in-previews).
  The latter reports $13M nominal, separately from $21M inflation-adjusted.
  Its cost date is assigned to the end of mounting, the
  [November 17, 1994 opening](https://playbill.com/article/celebrate-25-years-of-sunset-boulevard-with-a-look-back-at-the-original-broadway-production),
  rather than the 2017 publication date or the separate 2017 revival.
  The index predicts $12.19M, a signed error of -6.3%. Both financial articles
  were readable directly. This is a development-budget comparison, not a
  measurement of annual operating-cost inflation; the opening date convention
  does not establish when individual expenditures occurred.
* **Funny Girl (2022):** [June 14, 2023 interim report](https://www.broadwayjournal.com/p/eddie-redmayne-led-cabaret-will-transfer-to-broadway-in-2024-exclusive)
  gives $15M capitalization; [August 7 recoupment announcement](https://playbill.com/article/funny-girl-on-broadway-recoups-its-investment)
  gives $16.5M. The index predicts $15.09M, a signed error of -8.6%.
  These are contemporary reports about the same production. They establish
  a revision in the reported amount, not that $1.5M was spent between those
  dates. A correction to the earlier report cannot be excluded. Broadway
  Journal was readable directly; Playbill's amount and date were verified
  in indexed article text because its direct page returned HTTP 403.

The existing Phantom comparison is a control: its +10.8% error is unchanged.
The two additions belong to the card's permitted capitalization category,
but share the existing ledger's limitation that budget revisions are not
isolated price inflation. The checker still needs to resolve the counting
questions in the card, including development budgets, same-amount pairs and
multiple intervals from one production. No ruling was assumed for Rebecca,
which remains excluded because it never opened.

### Additional leads excluded in this pass

* **Sweeney Todd (2023):** the
  [August 2022 budget](https://www.broadwayjournal.com/p/will-a-new-sweeney-todd-make-its-investors-a-killing-exclusive)
  supplies $840,000 projected weekly costs, excluding royalties and percentage
  rent. Jeffrey Seller's [April 2025 podcast](https://freakonomics.com/podcast/on-broadway-nobody-knows-nothing/)
  supplies only a later lower bound above $900,000 and does not give the
  interview date. Neither an exact later cost nor a comparable cost basis is
  established. The $14.5M maximum capitalization is also a ceiling.
* **King Kong:** [August 2018 financial papers](https://www.broadwayjournal.com/p/lavish-dolly-earns-modest-returns)
  give a $33.5M to $36.5M capitalization range. Do not turn either endpoint
  into a point budget to pair with a subsequent mounted cost.
* **Frozen:** the [Denver review roundup](https://www.broadwayworld.com/article/Review-Roundup-What-Did-The-Critics-Think-of-Broadway-)
  relays a $25M to $30M development-budget range, not two dated observations.
* **Harry Potter:** [2018 expenses reported in 2019](https://www.broadwayjournal.com/p/harry-potter-the-cursed-box-office-yardstick)
  are $1.1M weekly excluding royalties. The
  [December 2025 report](https://www.broadwayjournal.com/p/harry-potters-cursed-returns)
  gives only a bound above $1M, after the change from two parts to one.
* **Phantom:** the [Financial Times article](https://www.ft.com/content/656482c3-339e-4655-8a90-c1518d89cad8)
  linked by a September 2022 press digest was paywalled. Secondary reproductions
  attribute $850,000 before the pandemic and approximately $950,000 afterward
  to Mackintosh, but a sufficiently precise earlier cost period and the
  primary publication date were not established here. No extra overlapping
  interval was added to the existing Phantom comparison.
* **Titanic and Victor/Victoria:** multiple trade articles repeat their
  original capitalization. Republishing the same historical cost does not
  establish another cost date, so those repetitions were not counted.

### Verification and remaining work

The real writer is the manually curated JSON: `loadLedger()` in
`scripts/lib/cost-anchor-ledger.js` reads it and the existing
`scripts/backtest-cost-index.js` calls both `loadLedger()` and `evaluateLedger()`.
No new script, function, flag, API call, paid fetch, LLM call or cron was added.

Before editing, the ledger, validator, carry function, backtest helper and
acceptance test matched `origin/main` (`git diff origin/main -- ...` was empty).
The acceptance command already passed all eight tests. The required
`git log -S 'cost-anchor-ledger' --oneline -5` failed because fetching a missing
partial-clone object tried to write to the read-only Git object directory;
this did not prevent reading the current main ledger for the before/after
comparison.

Completion still requires both commands, with exit 0 from each:

```sh
node --test tests/unit/cost-anchor-ledger.test.mjs
node scripts/backtest-cost-index.js
```

The first passes 8/8 before and after. The second exits 2 before and after;
after these additions, coverage is the remaining failing check. The Linear
VERIFY line was not edited by this unattended worker. The runner should add
the second command to the card's verification requirements.

Targeted regression verification: 88 tests passed, zero failures across the
six existing test files that exercise the ledger or its carry dependencies:

```sh
node --test --test-timeout 300000 tests/unit/cost-anchor-ledger.test.mjs tests/unit/cost-for-week.test.mjs tests/unit/cost-history.test.mjs scripts/lib/commercial-conversion.test.mjs tests/unit/model-audit-invariants.test.mjs scripts/lib/deep-research-cleared-cost.test.mjs
```

`git diff --check` passed. No TypeScript, test files, scripts or workflow
configuration changed, so TypeScript and workflow audit runs were not needed.

Eighteen more qualifying pairs are still needed: five pre-2010, six for
2010-2019 and seven for 2020+. Once coverage is met, rerun the index check and
`node scripts/backtest-recoupment-ground-truth.js --opt=datedCosts`; require no
category worse and zero new false recoupments. That conditional promotion
backtest was not run while coverage remains incomplete. The owner or checker
must also resolve the conflict with `MUSICAL_LIVE_OPTS.datedCosts: true` in
`scripts/lib/recoupment-model.js`; live behavior is unchanged here.

## BRO-5018 research update, October 29 (historical)

Research date: 2026-10-29. **Incomplete: 10 pairs, with 20 still missing.**
The before column is the eight-record ledger supplied for this research pass.

| Earlier observation's era | Before | After | Still needed | Median absolute index error |
| --- | ---: | ---: | ---: | ---: |
| pre-2010 | 3 | 4 | 6 | 21.0% |
| 2010-2019 | 3 | 4 | 6 | 9.1% |
| 2020+ | 2 | 2 | 8 | 7.9% |

The overall sourced-ledger median absolute error is 11.2%. These small samples
cannot establish the index's accuracy. Two new capitalization comparisons join
the eight existing comparisons, which are unchanged. Capitalization budget revisions,
especially during development delays, are different from annual running-cost
inflation. The report exposes errors for each kind separately. No commercial
records, cost history, cost index, recoupment options or model inputs changed.
The pre-2010 median increased from 13.7% to 21.0%, exceeding the existing 15%
index-error limit: `indexPass` is now false as well as `coverageReady`.
The new observations are retained despite worsening the index's fit.

### Completion check

Run both commands:

```sh
node --test tests/unit/cost-anchor-ledger.test.mjs
node scripts/backtest-cost-index.js
```

The first command validates evidence and boundary behavior. It already passed on
the supplied main checkout with eight ledger records, so it is not a
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

### Observations added October 29

All amounts are USD. The Addams Family's [May 22, 2007 development announcement](https://www.comicsbeat.com/studio-briefing-2-addams-family-to-bway/)
in the comics trade publication The Beat reports a $10M Broadway budget.
Playbill's [April 9, 2010 opening-week report](https://playbill.com/article/playbillcoms-theatre-week-in-review-april-3-9-addams-and-tenor-open-on-broadway-com-167534)
reports $16.5M capitalization. Its separate $15M advance is ticket sales and is
not used. The index predicts $10.90M, a signed error of -34.0%.

Rocky's [April 28, 2013 Broadway announcement](https://www.broadwayworld.com/article/Its-Official-ROCKY-The-Musical-is-Headed-to-Broadways-Winter-Garden-Theatre-20130428)
relays Bill Taylor of Stage Entertainment USA's approximately $15M Broadway
budget, explicitly distinguished from the Hamburg production. Playbill's
[opening-night report, published March 14, 2014](https://playbill.com/article/playbill-on-opening-night-rocky-ringside-at-the-winter-garden-com-216058)
reports $16.5M for the production that opened March 13. The later cost date is
that opening date. The index predicts $15.40M, a signed error of -6.7%.

Both compare a development budget with capitalization reported at opening, not
two audited final expenditures. Development changes are not isolated from price
inflation. The Beat and BroadwayWorld pages were readable directly; Playbill
figures and publication dates were verified in indexed article text because
direct opens returned HTTP 403. The existing Phantom running-cost comparison
was also rerun as a control: its +10.8% error is unchanged.

### Observations added October 25

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
* **Rebecca:** Playbill's [October 3, 2012 report](https://playbill.com/article/cast-of-rebecca-mourns-shows-collapse-middleman-between-producer-and-lost-investor-named-com-198278)
  describes a $12M budget at the canceled start of rehearsals. Its
  [April 12, 2013 report](https://playbill.com/article/with-8-million-in-place-rebecca-producers-work-to-raise-remaining-capital-com-204321)
  quotes Ben Sprecher's April 9 interview: a revised $15M expected cost, with
  only $8M identified and a distinct $16M authorized ceiling. This planned
  Broadway production never opened. No ledger pair was added; the checker
  must decide whether budgets for an unmounted production qualify. Neither
  the amount raised nor the ceiling is a second cost observation.

### Caller, existing fix and remaining decision

`scripts/backtest-cost-index.js` imports `loadLedger()` and `evaluateLedger()`
from `scripts/lib/cost-anchor-ledger.js`. That loader reads the manually curated
ledger directly. The same backtest separately calls `loadSeries()` in
`scripts/lib/cost-index-backtest.js`, which reads seeds and commercial cost
histories. Those histories include estimates, explaining why its 1,328 point
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
still required for six pre-2010 pairs, six 2010-2019 pairs and eight 2020+
pairs; no unverified leads or repeated publication dates were counted to fill
those gaps.
