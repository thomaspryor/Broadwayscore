# BRO-4623 commercial readiness audit

Rechecked November 11, 2026 against main `df03de98d2a` and the runner's private-data snapshot. This replaces the October 17 report. No private financial records or feature flags were changed.

**Assessment:** `/biz` is already public, following the October 26 release recorded under BRO-6192 in `src/config/feature-flags.ts`. The old orphan, coverage and Company corrections are present. The weekly pipeline and current grosses are healthy. The daily pending-review publisher has a reproducible validation defect, fixed in this diff but still requiring a successful deployed run. Financial estimates remain estimates; zero HIGH audit findings is not a certification of every claim.

## System, freshness and coverage

`commercial.json` holds slug-keyed records. `grosses.json` supplies the latest week and cumulative totals; `grosses-history.json` supplies the weekly observations used by `scripts/merge-model-recoupment.js`. `src/lib/data-commercial.ts` and `src/lib/data-grosses.ts` feed `/biz`. Research, Friday announcements, hourly RSS and daily pending review reach `scripts/apply-commercial-pending.js`; its shared record validator is the same one used by whole-file validation.

Read-only GitHub checks returned:

| Pipeline | Schedule | Latest completed run | Result |
| --- | --- | --- | --- |
| Commercial weekly | Saturday 18:00 UTC | [November 7, 42415676937](https://github.com/thomaspryor/Broadwayscore/actions/runs/42415676937) | success |
| Commercial Friday | Friday 22:00 UTC | [November 7, 42324012103](https://github.com/thomaspryor/Broadwayscore/actions/runs/42324012103) | success |
| Weekly grosses | Tuesday/Wednesday 15:00 UTC | [November 10, 42903082769](https://github.com/thomaspryor/Broadwayscore/actions/runs/42903082769) | success |
| Commercial RSS | hourly | [November 11, 43060711385](https://github.com/thomaspryor/Broadwayscore/actions/runs/43060711385) | success |
| Stale closures | daily 08:00 UTC | [November 11, 43052139380](https://github.com/thomaspryor/Broadwayscore/actions/runs/43052139380) | success |
| Pending review | daily 09:17 UTC | [November 11, 43065802556](https://github.com/thomaspryor/Broadwayscore/actions/runs/43065802556) | failure, same defect as the preceding two runs |

The weekly check supplied by the card passes on unchanged main. A stronger three-run check fails: November 7 and November 2 passed, but October 31 failed. Do not claim three consecutive successful weekly runs.

Snapshot freshness: grosses updated November 10 at 21:16 UTC, covering November 8, the latest completed Sunday. Commercial metadata updated November 11 at 15:51 UTC; model runs are dated November 11. The persisted model-history checker passes with its latest observation on November 7, 125 AI-estimated records and no rising model drift. The public page returned by the web reader still displayed November 1 grosses and a November 10 model run, so snapshot freshness is not proof the latest snapshot has deployed.

Coverage is **477 matched commercial records, zero orphan keys, 62/62 open/previews/announced/upcoming Broadway shows covered**. Among Broadway productions opened from January 2023 through November 11, 2026, all 138 have entries; the 2025 onward subset is 62/62. Coverage does not imply full financial disclosure: 304/477 have capitalization, 118/477 weekly running costs, and 430/477 structured sources.

`860` is absent; Wanted and Downstate are present; Company is already `Fizzle` with `reported-loss` basis. The old `bro-4623-orphan-key` and `bro-4623-coverage-outcome` plans still have pending metadata, but their requested outcomes are present. Do not replay stale compare-and-set actions.

The pending queue has **85 entries, oldest 137 days** (The Lost Boys, researched June 27). All have research timestamps; 45 are low confidence, 34 medium and six high. Ten contain recoupment claims. The queue's current file timestamp does not make those individual rows fresh. No pending row was released or deleted by this audit.

## Reproduced publisher failure and fix

The daily run applied the canonical Billy Crystal row as `TBD`, then its ID-keyed pending sibling as `Easy Winner` with `recouped=null`. Whole-file validation rejected that contradiction, preventing the entire batch from publishing. The invalid row fails independently; alias duplication is not the underlying defect.

The caller already ran `commercialRecordErrors()`, but only inside the `RELEASE_HELD` branch. Ordinary daily, weekly, Friday and single-show updates bypassed it. The fix runs the existing validator for every candidate after source processing and sanitization, before assignment. Invalid candidates remain pending with a review reason. It does not manufacture recoupment evidence or change validation rules.

Real-data replay, with page fetching disabled and no writes:

```sh
node scripts/apply-commercial-pending.js --dry-run --all --no-source-verify
```

Before: 21 proposed writes, 64 skipped. After: 20 proposed writes, 65 skipped. Exactly one pending record changes disposition: `billy-crystal-860-2026` is held for its invalid win label. All 20 remaining proposed records are identical after removing execution timestamps. Examples: the canonical `billy-crystal-860` stays TBD/null, `the-lost-boys-2026` stays TBD/false, and `now-you-see-me-live` stays TBD with no asserted recoupment. Financial files were never written. This replay checks row handling, not external source verification.

The regression in `tests/unit/commercial-pending-identity.test.mjs` failed before the fix because both invalid win records were accepted. It now proves that bulk and single-show applies hold those records while accepting a valid unknown outcome. The test invokes the real CLI; it copies no decision logic. `test.yml` already includes `scripts/apply-commercial-pending.js` in `on.push.paths`.

## Accuracy and the remaining model limits

The initial audit returned 282 findings: 1 HIGH, 0 MEDIUM, 281 LOW. Its sole undiagnosed false negative was Legally Blonde. Adding its researched explanation changes exactly one audit classification, yielding **0 HIGH, 0 MEDIUM, 282 LOW**, with all ten model disagreements still visible. No model output or recoupment fact changes.

The real model was run for three cases:

| Production | Central model result | Diagnosis |
| --- | --- | --- |
| Legally Blonde | -58.7% | Broadway-only model excludes later productions; magnitude also understates the reported Broadway distribution |
| Kimberly Akimbo | -66.3% | Existing diagnosis distinguishes Broadway weeks from later tour income |
| Gutenberg! | 94.5%, range 66.9%-120% | Existing borderline diagnosis, with 100% inside the range |

Legally Blonde has 81 weekly rows from April 8, 2007 to October 19, 2008 and $56.34M cumulative gross. Its model uses the reported $650K weekly cost, variable expenses and a $1.95M reserve. [Freakonomics' interview with Hal Luftig](https://freakonomics.com/podcast/on-broadway-nobody-knows-nothing/) reports roughly 60% of $11M returned on Broadway and profitable later touring productions. The interview does **not** verify repayment of the original Broadway investors or a 2012 recoupment date. [BroadwayWorld's contemporary cost report](https://www.broadwayworld.com/article/Variety-Reports-on-New-Economys-Effect-on-Broadway-20090220) supports the $650K cost quote but does not establish a complete cost history. The explanation records both the scope mismatch and unresolved magnitude error; it is not a calibration fix or independent confirmation of the record's date.

Three of the original seven model disagreements are already resolved: MJ, The Outsiders and Romeo + Juliet now have `modelRecouped=true`. Broadway News independently supports [MJ's $22.5M recoupment](https://www.broadwaynews.com/broadways-mj-recoups/) and [The Outsiders' $22M recoupment in the week ending December 28, 2025](https://www.broadwaynews.com/broadways-the-outsiders-recoups-its-investment/). The remaining disagreements have explicit input diagnoses in `scripts/lib/model-false-negative-explanations.js`; several still need sourced running costs or capitalization. A diagnosis does not establish model accuracy.

Only Parade 2023 and Indecent 2017 remain closed/TBD, both explicitly human-reviewed. [American Theatre's Indecent account](https://www.americantheatre.org/2019/03/06/daryl-roth-producing-with-a-purpose/) describes breaking even after an extension but supplies no explicit investor repayment date. This is the same evidence already reviewed in its record. No new sourced final outcome was established for either show; their locks and labels remain intact.

The four items previously called stale forecasts are **old estimate observation dates**, set alongside `estimatedRecoupmentPct` by `update-commercial-data.js`, not promised recoupment dates. Gatsby, Buena Vista Social Club and Operation Mincemeat have newer analyst observations dated November 4. Stranger Things has a November 11 model run. The public selector explicitly excludes the legacy estimate fallback (`src/lib/commercial-display.ts`); none of these TBD records can use the old date as a recouped return-snapshot label. The four historical freshness advisories remain visible.

The 282 LOW findings comprise 216 source-quality, 26 nonprofit-classification, 23 methodology, ten diagnosed model disagreements, four stale estimate observations, two reviewed closed/TBD outcomes and one financial-shape advisory. They are not 282 established factual errors. The nine-week grosses integrity check has four report-only findings and zero alert-tier findings: capped Other Desert Cities capacity and three missing Billy Crystal seats-offered values. Repairing those source limitations requires separate source retrieval, not inferred numbers.

## Verification and operational limits

A repeatable behavioral VERIFY for this fix, already collected by CI:

```sh
node --test --test-timeout 300000 tests/unit/commercial-pending-identity.test.mjs tests/unit/model-false-negative-explanations.test.mjs
```

Data acceptance and operational recheck:

```sh
node scripts/audit-commercial-data.js
node scripts/audit-commercial-data.js --strict
node scripts/check-workflow-run-status.js --workflow=commercial-weekly.yml --expect=success
node scripts/check-workflow-run-status.js --workflow=commercial-pending-daily.yml --expect=success
```

The first three pass locally. The last remains red until the publisher fix is deployed and a run succeeds. The default audit exits zero even with findings; inspect its summary rather than treating exit zero as a launch certificate.

Targeted and nearby validation completed:

```sh
node scripts/calculate-recoupment.js --show=legally-blonde-2007
node scripts/calculate-recoupment.js --show=kimberly-akimbo-2022
node scripts/calculate-recoupment.js --show=gutenberg
# all exit 0; model results and limitations tabulated above
node --test --test-timeout 300000 tests/unit/merge-commercial-data.test.mjs tests/unit/model-false-negative-explanations.test.mjs tests/unit/commercial-pending-identity.test.mjs tests/unit/commercial-source-verify.test.mjs tests/unit/commercial-publish-gate.test.mjs tests/unit/commercial-apply-gate.test.mjs scripts/lib/commercial-tip-record.test.mjs scripts/lib/classify-stale-closure.test.mjs
# 223 passed, 0 failed
node --import tsx --test --test-timeout 300000 tests/unit/commercial-display.test.mjs tests/unit/commercial-model-display-guard.test.mjs
# 50 passed, 0 failed; plain node without tsx cannot resolve their TS imports
env -u GITHUB_STEP_SUMMARY node scripts/check-grosses-integrity.js --weeks=9
# exit 0: four report-only findings, zero alert-tier findings
env -u GITHUB_STEP_SUMMARY node scripts/pending-review-backlog.js
# 85 entries, oldest 137 days
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
# only failing subgate: actionlint is not installed; every other subgate passed
git diff --check
# pass
```

The inherited `GITHUB_STEP_SUMMARY` points outside the writable checkout; unsetting it resolves the summary-write error without changing code. The previously dependency-blocked coverage, record and publish-gate tests also passed. Two independent agent reviews found no blockers. The external API portion of the session review checklist was unavailable because `OPENAI_API_KEY` is absent; no external-review pass is claimed. No TypeScript or UI source changed, so no type check or build was needed. The mandated session claim could not run (`LINEAR_API_KEY not set in .env or environment`); no Linear mutation succeeded.

History: HEAD and origin/main were identical before edits. `git log -S 'MODEL_FALSE_NEGATIVE_EXPLANATIONS' --oneline -5 -- scripts/lib/model-false-negative-explanations.js` found `e93cc28d3c6` (BRO-6140). Broader searches could not complete because this partial checkout has missing promisor objects and its shared `.git/objects/pack` directory is read-only. The current-main workflow check, real publisher replay and full audit were executed before changes, so the reproduced defect is not inferred from stale comments.

Existing callers are wired: weekly/Friday/RSS/daily workflows invoke `apply-commercial-pending.js`; `audit-commercial-data.js` imports and calls `splitModelFalseNegatives`. No script, flag, workflow, dependency or cron was added. Added network operations per application run: **zero paid fetches, zero LLM calls, zero API calls**. The existing held-row handler may review the newly flagged invalid row under its existing limits. This audit used read-only public-source and workflow requests; it did not run paid research.

Remaining: verify a successful deployed daily pending run and the November 8 data on the live page; settle the invalid Billy Crystal pending claim only with evidence; source the unresolved model inputs and any future Parade/Indecent outcomes. The October production hold has already been lifted; this audit makes no new release decision.
