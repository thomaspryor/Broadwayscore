# BRO-6187 commercial estimate follow-up

Verified against the supplied core-data snapshot on 2026-10-26.

## Drift sizing and its writer

`scripts/merge-model-recoupment.js` writes the model fields and calls
`planModelLossResizes()` after its model run. That planner previously handled
loss labels only and deliberately stopped at 100%. It now also sizes unlocked
`model-estimate` tiers across 100% and 150%, using the existing canonical
`estimatedDesignationForClosed()`. Reported recoupments, human locks, special
classes, the guessed-input exclusion and the three-move circuit breaker remain
authoritative. Contradiction flags are calculated after resizing, against the
final designation. No recouped flag or source is changed by sizing.

The new regression file initially printed **5 pass, 7 fail**. The final affected
test run printed **245 pass, 0 fail** across 16 files, including the existing
TypeScript-dependent tests run with `--import tsx`.

Real-data comparison using the main version and changed version of the planner:
332 writer-eligible commercial records, **0 moves before, 0 moves after**. The
full real model dry-run covered 433 records and likewise printed **0 designations
re-sized**, with 4 contradiction flags. This snapshot needs no automatic drift
backfill. The Crucible's stored Flop at 43.6% remains excluded because its
capitalization input is a comparable, which the existing writer guard forbids
using to resize a public label.

Controlled drift replays changed only the model range on real record copies:

| Record | Replayed middle | Main planner | Changed planner |
| --- | ---: | --- | --- |
| macbeth-2022 | 90% | Keeps Trickle | Fizzle |
| death-of-a-salesman | 140% | Keeps Windfall | Trickle |
| a-dolls-house-2023 | 20% | Keeps Trickle | Keeps Trickle, human lock |

The third lock was explicitly added in applied plan `bro-6245-b.json` and must
survive this change.

## Recent closings and stunt casting

`getRecentClosings()` on origin/main already contains no 183-day gate.
`git log -S '183' --oneline -5 -- src/lib/data-commercial.ts` returns no commits.
Its existing `/biz` caller requests the past three months and passes each
designation's basis to `lossOutcomePhrase()`. The real function returns four
closures, aged 36, 71, 78 and 79 days. For example, Titanique is Flop with
`model-estimate` basis and renders "closed with no recoupment announced";
Ragtime is Fizzle with the same basis and phrase. No TypeScript change is needed.

The stunt-casting selector already includes closed productions. The cache
classifies all **754** study shows, including **729 closed shows**. Examples
include John Proctor, Macbeth and Evita. An existing selector test now explicitly
covers a closed production. The derived dataset was stale, so it was rebuilt
with `--no-classify`; no new headliner classifications were purchased. The four
commercial comparison groups' decided counts changed 45 to 81, 16 to 30,
24 to 34 and 66 to 93, reflecting current commercial designations. The final
`--check` prints **754 study shows, 0 unclassified, dataset current**.

## DNR keepers and the 39 locks

The card's 117-record cohort consists of **115 conversions** in applied plans
`bro-6158-r01.json` through `bro-6158-r10.json`, plus the two DNR keepers. There
are **38 locked conversions**, all matching their explicitly planned tier,
all still `model-estimate`, all still `recouped: false`. Every plan records
successful execution. The 39th original lock is Evita, which was kept as DNR,
rather than converted. The counts therefore account for all 117 entries and
39 original locks. No existing lock is cleared or overridden here. Examples of
locked conversions are The Lyons, Torch Song and The Great Society.

John Proctor and Evita both retain `Did Not Recoup`, `reported-loss` and
`recouped: false`, without adding a loss percentage. Their current model middle
figures are **118.5%** and **161.1%**, respectively, rather than the older figures
in the card. Evita already has its human lock. Pending plan `bro-6187.json` adds
John Proctor's missing lock. Replay through the real `applyDataEdit()` changed
**one record**, only its lock and the executor's `lastUpdated` stamp. Its source,
designation, basis and reported outcome were preserved; Evita was unchanged.
Preflight prints **bro-6187: 1/1 applied cleanly**.

The pending plan still requires execution against the private core-data repo.
The worker does not dispatch workflows or write that repo.

## Verification and cost

Commands run:

```sh
node scripts/validate-data.js --strict
node scripts/merge-model-recoupment.js --dry-run
node scripts/build-stunt-casting-dataset.js --check
node scripts/build-stunt-casting-dataset.js --no-classify
node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/bro-6187.json
node --test --test-timeout 300000 tests/unit/commercial-estimate-drift.test.mjs scripts/lib/stunt-casting.test.mjs
rg -l 'commercial-designations|merge-model-recoupment' tests scripts --glob '*.test.*' > /tmp/bro6187-affected-tests.txt
node --import tsx --test --test-timeout 300000 $(cat /tmp/bro6187-affected-tests.txt) scripts/lib/stunt-casting.test.mjs
node --test --test-timeout 300000 tests/unit/audit-log-gitignore.test.mjs
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
git diff --check
```

The two touched test files pass **25/25**. All 16 affected files also pass
**245/245** with `node --import tsx --test --test-timeout 300000`, using the
files found by `rg -l 'commercial-designations|merge-model-recoupment' tests
scripts --glob '*.test.*'` plus `scripts/lib/stunt-casting.test.mjs`. An initial
plain-node run of the TypeScript-dependent existing `model-input-basis` test
failed resolving `@/config`; its documented tsx runner passes. Workflow gauntlet
gate exit is **0**; unavailable actionlint is the permitted environment warning.
The gitignore tests pass **11/11**, covering the plan and report inclusion edits.
No TypeScript or review-scoring logic was edited.

Strict validation fails identically before and after, with **two existing
review-data errors**, while reporting **Commercial data valid for 433 shows**:

1. `therese-raquin-2015`: BritishTheatre.com cross-market review.
2. `art-west-end-2016/artshub--gina-fairley.json`: review dated 2016-01-29,
   326 days before the production's earliest date.

Those private review-text records require a separate verified correction; the
worker was explicitly instructed never to write the supplied review-texts clone.

Wiring: `commercial-weekly.yml`, `commercial-friday.yml`,
`commercial-stale-closures.yml` and other existing callers invoke the model
writer. The pending plan uses the existing approved-fix executor. The existing
stunt-casting builder writes the checked-in research dataset. **Zero new paid
fetches, LLM calls or API calls per run**, including the existing cron callers.
