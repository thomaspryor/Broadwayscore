# BRO-5870 prose capitalization and cost seeding

## Scope and baseline

Checked on 2026-10-29 against the runner's real data: 4,523 shows and 476
commercial records. Both source files match the clean attached core-data clone
at `da5111191e3c90cfac7d710cab3118273fa7b487` byte for byte. The clone has zero
commits ahead or behind its origin. The initial acceptance test already passes
all six tests, reporting 293 disclosed capitalizations and 126 AI estimates.
Passing that test does not prove the prose backfill was completed.

The original 105-figure roster is absent from this checkout. Current prose
cannot safely reconstruct it: later research has filled fields, intentionally
cleared others, and retained historical or incompatible figures. This follow-up
reviews ten current records before proposing any remaining seeding. It does
not claim that the original 105 figures have all been handled.

## Rubric

1. Work on an existing commercial record and its own production. Leave existing
   positive structured values unchanged. Skip nonprofits and tour stops, where
   a commercial capitalization or independently financed Broadway run is not
   established.
2. Only fill a missing field with prose explicitly about that financial input.
   Grosses, grants, losses, advances, royalties and tax credits are not budgets.
   A weekly sales threshold or breakeven figure is not a fixed running cost.
   Partial expenses and costs from selected weeks are not a typical weekly nut.
3. Honor `isFieldCleared()` and explicit prose explaining a deliberate removal.
   Old AI research cannot restore those figures. Do not erase research or clear
   flags to make a proposal eligible.
4. An unambiguous positive point estimate may be retained as an estimate. For
   a bounded range of the same input, use its arithmetic midpoint and retain
   the original range. Do not turn a one-sided floor or ceiling into a point
   estimate. Reject conflicting amounts until their dates and cost bases can
   be reconciled. Do not infer an amount from a URL or the absence of evidence.
5. Every seeded field gets `isEstimate.<field>: true` while preserving other
   estimate flags, and a source beginning `Estimate:` explaining the stored
   prose and transformation. A weekly estimate uses `industry-estimate`
   methodology. Do not invent a public citation, verification date or dated
   cost-history anchor. Undated estimates retain their date uncertainty.
6. Use the existing approved-fix generator and executor, with guarded old
   values and at most 25 actions per plan. Replay plans on an in-memory copy
   first. Confirm only intended records change, disclosed capitalization does
   not increase, and `modelInputBasis()` marks each seed as an estimate.
   Leave model outputs, designations and recoupment fields to existing writers.
7. Independently review a ten-record sample covering accepted and rejected
   cases before writing the batch plans. A rejection is a recorded decision,
   not permission to invent a replacement amount. The rest of the original
   cohort requires its actual roster or verified replacement evidence.

## Ten-record sample

| Record | Proposed decision | Reason |
| --- | --- | --- |
| `call-me-izzy` | Seed weekly cost at $300,000, labelled estimate | Midpoint of the stored $250,000 to $350,000 weekly industry-estimate range; no structured cost, anchor or cleared-field marker. Preserve the range. |
| `book-of-mormon` | Withhold | Older AI notes suggest $500,000 weekly; later notes give $760,000 excluding royalties in a historical period. These are not interchangeable total running costs. Preserve the reported capitalization. |
| `ragtime-2009` | Withhold | More than $500,000 weekly is a lower bound, not an exact weekly budget. Preserve the existing $8 million capitalization. |
| `in-transit-2016` | Withhold | $439,000 includes extras; below $400,000 is a breakeven bound. Capitalization prose expressly says it was left unset. |
| `groundhog-day-2017` | Withhold | Up to $17.5 million is a ceiling, and later research explicitly leaves capitalization unset. Keep the model-only comparables figure separate. |
| `hello-dolly-2017` | Withhold | Expenses exceeding $1.3 million in some weeks do not establish the typical running cost. Preserve the existing capitalization. |
| `spider-man-turn-off-the-dark-2011` | Withhold | Weekly cost is only a lower bound and the production disputed the cited financial analysis. |
| `the-lion-king` | Withhold | Weekly cost is deliberately cleared. Capitalization notes contain competing speculative amounts and Disney does not disclose the budget. |
| `aladdin` | Withhold | Capitalization is deliberately cleared; a speculative range cannot restore it. Preserve the existing weekly estimate. |
| `mamma-mia` | Withhold | This is a tour stop. The speculative return-engagement budget must not become an independent Broadway capitalization. |

The proposed sample changes one record and one financial amount. Nine sample
records remain unchanged. No public reported capitalization is added.

## Independent review and plan

A separate GPT-6 Astra reviewer read all ten records, the estimate and
cleared-field guards, the commercial field executor, the cost reader and
record validator, plus applied plans `bro-5549.json` and `bro-4722-b.json`.
Its verdict was to proceed with Call Me Izzy only and withhold the other nine.
Historical core-data Git provenance is incomplete; this is not independent
verification of the old range or proof about every past clearing decision.

BRO-5549 cleared Call Me Izzy's incorrectly reported cost methodology, not a
cost amount. It did not reject a labelled industry estimate. The new plan
preserves its reported capitalization and `isEstimate.capitalization: false`.
The proposed cost source explicitly says the midpoint is unconfirmed and
undated. No cost-history anchor or new public-source claim is added.

`data/pending-fixes/bro-5870.json` contains four guarded field actions for that
one record: estimate flags, estimate source, industry methodology and amount.
The exact output of `new-fix-plan.js --id=bro-5870 --dry-run` was saved as the
pending plan after its preflight passed. A temporary preload selected the
runner's `data/` copies, avoiding refresh writes to the external clone; no
validation was replaced. The dry-run also avoids the generator's staging
step. The runner can apply the pending plan after landing.

## Verification

Preflight prints `bro-5870: 4/4 applied cleanly`. Replaying the actual actions
through `applyDataEdit()` on an in-memory copy changes exactly one of 476
records. Positive weekly costs increase from 115 to 116. Disclosed
capitalizations remain 293. The changed record passes `touchedRecordProblems()`
and `modelInputBasis()` returns a weekly-cost estimate. Every other record is
deep-equal to its original value, and the original cost range is preserved.

Three real-data examples through `costForWeek()`:

| Record and date | Before replay | After replay |
| --- | --- | --- |
| Call Me Izzy, closing 2025-08-24 | $529,251 category fallback | $301,309 carried estimate, low quality |
| Book of Mormon, 2026-10-29 | $617,436 category fallback | $617,436, unchanged |
| Aladdin, 2026-10-29 | $884,176 carried estimate | $884,176, unchanged |

The cost reader carries the $300,000 assumption using its existing cost index.
Its synthesized migrated date is a calibration date, not a verified source
date. No private source file was modified for these comparisons.

Commands and results:

```sh
node --test tests/unit/commercial-model-coverage.test.mjs
# PASS: 6 tests on the untouched source data, both before and after drafting.
node --test --test-timeout 300000 tests/unit/commercial-model-coverage.test.mjs tests/unit/cap-comparables.test.mjs scripts/lib/commercial-field-edit.test.mjs scripts/lib/commercial-record-checks.test.mjs
# PASS: 71 tests.
node --import tsx --test --test-timeout 300000 tests/unit/model-input-basis.test.mjs
# PASS: 6 tests.
node --import tsx --test --test-timeout 300000 tests/unit/git-add-existing.test.mjs tests/unit/check-file-sizes-post-stage.test.mjs tests/unit/cloud-routines-docs.test.mjs tests/unit/opening-night-lane-lease-wiring.test.mjs tests/unit/done-evidence-audit.test.mjs tests/unit/reconcile-retired-ids.test.mjs tests/unit/rebuild-fast-push-retry.test.mjs tests/unit/review-gate-verdict-attribution.test.mjs tests/unit/pr-supervisor-core.test.mjs tests/unit/owner-email-guidelines.test.mjs tests/unit/review-gate-evidence.test.mjs tests/unit/git-add-safe.test.mjs tests/unit/cookie-renewal.test.mjs
# PASS: 264 tests in the 13 test files mentioning .gitignore.
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh tmp/bro-5870/gauntlet
# FAIL: existing lint-committed-pii findings; all other gates pass.
node scripts/lint-committed-pii.js
# FAIL: repeats the same existing findings in the two audit files below.
git diff --quiet origin/main -- scripts/lint-committed-pii.js scripts/lib/pii-scan.js data/audit/done-evidence-audit.json data/audit/we-historical-tr-probe.json
# PASS (exit 0): checker, scanner and both failing inputs match current main.
git diff --check
# PASS.
```

An initial combined test attempt without the TS loader passed 19 tests and
failed loading `model-input-basis.test.mjs`: its TypeScript dependency could
not resolve `scripts/lib/our-recoup-estimate`. The test explicitly belongs in
the tsx batch; rerunning it with `--import tsx` passes. There is no runtime
code change here. `HEAD` and `origin/main` were both `03286d0169`; the search
`git log -S 'isDisclosedCapitalization' --oneline -5 -- scripts/lib/cap-comparables.js`
finds the existing implementation at the available snapshot boundary
`92d38150`. No already-passing coverage logic was changed.

The workflow audit completed in 269 seconds. Its full 1,161-line log covers
69 sections and identifies one failing gate, `lint-committed-pii`, on
`data/audit/done-evidence-audit.json` and
`data/audit/we-historical-tr-probe.json`. The checker, scanner and both inputs
are identical to current `origin/main` at `2e52dcea06`; repeating the checker
fails on the same files. These are baseline failures, unrelated to the new
plan and documentation. Missing `actionlint` is the permitted environment
warning. The log was inspected before deleting the temporary directory.

Only `.gitignore`, this rubric and the pending plan remain changed. The two
ignore exceptions ensure the runner can collect the new files. Source data
still matches the clean core clone after verification. No unrelated tracked
file required restoration.

Cost: zero new paid fetches or API calls in the implementation, and one
independent model review during this task. No new recurring or cron calls.

Remaining: recover the actual original 105-figure roster and reconcile each
item against subsequent corrections before creating the rest of the batch.
The current record count and the passing coverage test cannot prove that
cohort was completed. Live re-research of withheld figures is outside this
plan. Applying the pending plan is the runner's responsibility.

## Existing wiring

`scripts/new-fix-plan.js` routes `--commercial-edit` to `data-edit` actions on
`commercial.json`. `scripts/lib/data-edit-action.js` calls
`applyCommercialFieldEdit()` in `scripts/lib/commercial-field-edit.js`.
`scripts/execute-approved-fix.js` is the existing plan consumer.
`scripts/lib/model-input-basis.js` recognizes the estimate flag and source
prefix; `scripts/merge-model-recoupment.js` already stores that basis.
No new parser, cron, paid fetch or model research pipeline is needed.
