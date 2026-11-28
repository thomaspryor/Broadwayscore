# BRO-6187 commercial estimate follow-up

Rechecked against the supplied real data on 2026-10-28. The runtime fixes and
John Proctor lock have already landed. This follow-up refreshes the derived
stunt-casting dataset and supplies a field-fix plan for the remaining strict
validation error. No runtime code or private source files were changed.

## Already implemented on main

`merge-model-recoupment.js:192` calls `planModelLossResizes()` after writing
model figures. The planner handles unlocked model estimates across 30%, 100%
and 150%, preserving reported outcomes, human locks, special classes, guessed
input exclusions and the three-move circuit breaker. Existing cron workflows
`commercial-weekly.yml`, `commercial-friday.yml` and
`commercial-stale-closures.yml` invoke that writer.

The real model dry-run covered **476 records**: 342 weekly models, 8 lifetime
models and 126 estimate passthroughs. Before and after this follow-up its output
was identical: **0 designation resizes**, 4 contradiction flags. The stored
planner check also found 0 moves across 373 writer-eligible records. No drift
backfill is needed. The existing drift regression tests pass 13/13.

`getRecentClosings()` at `src/lib/data-commercial.ts:817` has no 183-day gate.
Its existing caller in `src/lib/biz-developments.ts` uses 3 months for the short
list and 24 months for the full list, with the designation basis passed to
`lossOutcomePhrase()`. Running the real function with `node --import tsx`
returned four closures aged **38, 73, 80 and 81 days**. Titanique (Flop) and
Ragtime (Fizzle) both render "closed with no recoupment announced"; Death of a
Salesman (Windfall) renders "closed". All are model estimates.

Main check: `git log -S 'BRO-6187' --oneline -5 --
scripts/lib/commercial-designations.js` finds the available history boundary
`b6ad9230`; `git log -S '183' --oneline -5 -- src/lib/data-commercial.ts` is
empty. No runtime fix was repeated. The validator and relevant review guards
have no diff between HEAD and origin/main; the validator blob is
`c773afd6e32caf55169db38213e488650f1b5c51` on both.

## Closed-show stunt casting

Initial `node scripts/build-stunt-casting-dataset.js --check` failed:
**754 study shows, 1 unclassified, dataset STALE**. The existing selector already
includes closed shows; no selector change or paid classification is needed.
Rebuilding with `--no-classify` refreshed the aggregates from current commercial
and grosses data. The next `--check` passes: **754 study shows, 1 unclassified,
dataset current**. All **729 closed study shows** retain classifications.

Examples: John Proctor retains Sadie Sink as screen and Gabriel Ebert as stage;
Macbeth retains Daniel Craig and Ruth Negga as screen; Evita retains Ricky
Martin as music, Elena Roger and Michael Cerveris as stage. No headliner cache
entry was changed. The only changed public production row is the running
`six-2021`, omitted by the existing builder because its input hash is stale.
The builder tolerates this 1/754 coverage gap; refreshing that running show's
classifier cache would require a prohibited nested model run and is outside
the closed-show requirement.

The four comparison groups' decided counts change **81 to 93**, **30 to 32**,
**34 to 34**, and **93 to 95**. Public rows contain neither designation nor
outcome. `src/app/biz/stunt-casting/page.tsx:58` reads this generated dataset.

## DNR keepers and the 39 original locks

The original 117-entry cohort is 115 conversions in applied plans
`bro-6158-r01.json` through `bro-6158-r10.json`, plus two DNR keepers. All ten
plans record successful execution. There are **38 locked conversions**, plus
Evita's original lock, accounting for **39 original locks**. All 38 conversions
still have their locks, model-estimate basis and recouped:false. Of these, 37
retain the exact planned tier; Lightning Thief's later Flop-to-Fizzle change is
explicitly authorized by applied plan `bro-6282-d.json`, after capitalization
was corrected. It is preserved. Locked examples still matching their original
Flop tier are The Lyons, Torch Song and The Great Society.

John Proctor and Evita both retain **Did Not Recoup**, **reported-loss**,
**recouped:false** and **humanReviewedDesignation:true**, with no analyst or
outside loss percentage. Their current model middle figures are 118.5% and
161.1%. Plan `bro-6187.json` is already applied, executed 2026-10-26T04:52:22Z;
no further lock plan is needed.

## Remaining validation error and source repair

`node scripts/validate-data.js --strict` failed with **one existing error**:
`art-west-end-2016/artshub--gina-fairley.json`, dated 326 days before the
production. Commercial data passes for all **476 records**. The earlier
Therese Raquin cross-market error no longer occurs.

Reading the stored Art article confirms it discusses Singapore museums,
visual-art fairs and cultural policy, rather than the Old Vic play. The bad
clear was written by `reverify-nulled-cv-promoted.js:266-287`; the record's
script-made clear timestamps identify that recovery. The correction targets
the source review record, leaving the validator unchanged.

New plan `data/pending-fixes/bro-6187-2.json` sets a manual non-review reason,
then isNonReview:true, using the existing review-field executor. Preflight
prints **2/2 applied cleanly**. Replaying through the real
`executeReviewFieldEditIn()` on a temporary copy changes **one record** from
includable to excluded, with reason **nonReview**. Its text and date are
unchanged. The source review-texts clone is never written.

Full strict validation with that executor-produced copy substituted for just
the Art file passes with exit 0. The command was
`node --require ./tmp/bro-6187-verification/review-overlay.cjs
scripts/validate-data.js --strict`. The temporary preload only redirects that
one file read; every other record and all validation logic remain real. The
unmodified snapshot still needs plan execution before plain strict validation
can pass. Temporary copies and the preload were removed after verification.

The generator wrote and preflighted the plan, but its automatic staging step
failed because the worktree git index is read-only. A narrow `.gitignore`
exception makes the plan visible to the runner without staging it.

## Verification and cost

Commands run in this follow-up:

```sh
node scripts/validate-data.js --strict
node scripts/merge-model-recoupment.js --dry-run
node scripts/build-stunt-casting-dataset.js --check
node scripts/build-stunt-casting-dataset.js --no-classify
REVIEW_TEXTS_DIR="$PWD/data/review-texts" node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/bro-6187-2.json
node --test --test-timeout 300000 tests/unit/commercial-estimate-drift.test.mjs scripts/lib/stunt-casting.test.mjs
node --import tsx --test --test-timeout 300000 tests/unit/biz-header-hero-style.test.mjs tests/unit/biz-share-preview.test.ts tests/unit/audit-log-gitignore.test.mjs
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh tmp/bro-6187-gauntlet
git diff --check
```

Targeted tests pass **25/25** and **17/17**. No test files, TypeScript, UI code,
review-scoring logic or workflows were edited. Plan application remains the
runner's responsibility after landing. The existing approved-fix executor at
`scripts/execute-approved-fix.js:554` calls `executeReviewFieldEditIn()`.

The first workflow audit printed all gates green, but `/tmp/gauntlet`
disappeared before the harness saved its exit and metadata files. The gate was
repeated in a task-specific directory to preserve its result. Missing
actionlint is the permitted environment warning. The repeat printed
**lint-workflows: all gates green**, saved **lint-workflows=0**, and exited 0.
The full log was read before removing the temporary directory.

**Zero new paid fetches, LLM calls or API calls per run**, including existing
cron callers. The dataset rebuild used only cached classifications.
