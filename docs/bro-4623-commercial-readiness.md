# BRO-4623 commercial readiness audit

Checked October 17, 2026 against the runner's private-data snapshot. Changes are in the working tree only. Private-data plans are pending, not published.

**Release assessment: retain the production hold.** The previously failing weekly pipeline is now green and the latest grosses week is current. Two source-backed data corrections and one orphan cleanup have been rehearsed locally. Eighteen closed-show outcomes remain unknown, and seven models disagree with announced recoupments. An audit exit of zero does not certify public launch readiness. The owner's existing decision to keep production hidden remains in force; releasing it requires the owner.

## System and freshness

`commercial.json` stores slug-keyed financial records. `grosses.json` stores the latest week; `grosses-history.json` supplies model history. `src/lib/data-commercial.ts` and `src/lib/data-grosses.ts` feed `src/app/biz/page.tsx`. `PROD_HELD_FEATURES` in `src/config/feature-flags.ts:28` still includes commercial. No UI or feature flag was changed.

Four unauthenticated, read-only GitHub REST requests retrieved the latest three runs of each pipeline:

| Pipeline | Schedule in checkout | Latest completed run | Result |
| --- | --- | --- | --- |
| Commercial Weekly | Saturday 18:00 UTC | [October 10, 38086335564](https://github.com/thomaspryor/Broadwayscore/actions/runs/38086335564) | success; completed 23:14 UTC |
| Commercial Friday | Friday 22:00 UTC | [October 17, 38984460370](https://github.com/thomaspryor/Broadwayscore/actions/runs/38984460370) | success; completed 00:22 UTC |
| Weekly grosses | Tuesday and Wednesday 15:00 UTC | [October 14, 38620004906](https://github.com/thomaspryor/Broadwayscore/actions/runs/38620004906) | success |
| Commercial RSS | hourly | [October 17, 39005036053](https://github.com/thomaspryor/Broadwayscore/actions/runs/39005036053) | success; completed 05:08 UTC |

Grosses cover the week ending October 11, 2026, updated October 13 at 20:36 UTC. That is the latest completed Sunday week at the time of this check. Commercial metadata and models were updated October 17. Workflow success alone does not prove every financial claim is accurate.

The pending queue contains 48 rows, including 19 marked for human review. All have research timestamps. The oldest is school-girls-or-the-african-mean-girls-play, September 19; death-becomes-her and downstate date to September 26. Queue-file lastUpdated is October 17, but that does not make the research in every row fresh. The separate research queue has two targets and was updated October 16. No queue row was deleted or automatically released.

## Reproduction, changes, and record counts

Before changes, `node scripts/audit-commercial-data.js` exited 0 with 425 findings: 8 high, 19 medium, 398 low. It reported orphan key `860` and claimed 245 running/previews shows lacked commercial records. The latter included other markets, even though the commercial writers intentionally cover Broadway only.

`getOpenCommercialCoverage()` now uses the existing `isCommercialScope()` predicate. The real coverage denominator changes from 274 to 30, removing 244 false gap warnings. Hamilton remains covered; Wanted was the only Broadway gap; Off-Broadway, West End, regional and tour productions are excluded. The scope calculation does not edit data.

The existing approved-fix action rejected the real cleanup with `drop-orphan-key: unsupported file commercial.json`. Its regression test failed before the change (9 pass, 1 fail). It now supports commercial deletion, protects both live IDs and live slugs, refuses missing slug context or a truncated shows list, and refuses commercial renames. `execute-approved-fix.js` supplies the slug set through its existing action dispatcher and guarded load/save path.

Two pending plans rehearse exactly three commercial-record changes, with no other record edits:

| Record | Before | After | Evidence |
| --- | --- | --- | --- |
| `860` | Unresolved TBD row with research/model bookkeeping only | deleted | No shows.json ID or slug matches it; Hamilton and mamma-mia-2001 deletion trials both refused |
| `wanted` | missing | TBD, financial values unknown | [Playbill, June 23, 2026](https://playbill.com/article/grammy-nominee-luke-james-to-star-in-wanted-on-broadway), confirms October 15 previews and November 8 opening at James Earl Jones Theatre |
| `company-2021` | TBD, recouped false | Fizzle, reported-loss basis | [Broadway Journal, August 23, 2022](https://www.broadwayjournal.com/p/will-a-new-sweeney-todd-make-its-investors-a-killing-exclusive), reports a loss and the lead producer's expected return of roughly one third, above the shared 30 percent Fizzle threshold |

Plans: `data/pending-fixes/bro-4623-orphan-key.json` and `data/pending-fixes/bro-4623-coverage-outcome.json`. Narrow `.gitignore` exceptions keep these public, PII-free plans visible to the runner. The six actions were replayed through the real `applyDropOrphanKey()`, `applyAddCommercialEntry()` and `applyCommercialFieldEdit()` functions. Shared record errors and warnings were empty for Wanted and Company. The generic plan preflight exits 0 but explicitly skips these action types; it is not the replay proof.

Writer tracing found `deep-research-commercial.js:1000` creates research bookkeeping stubs. Its existing missing-show check already skips unresolved keys. However, `apply-commercial-pending.js` still warned and then wrote unresolved keys from pending review. That existing caller could recreate `860`. Bulk apply now holds such rows; an explicitly named manual apply or held-row release retains the existing enrollment behavior. Running the real bulk dry run across all 48 pending rows changed candidates from 17 to 16: only `860` was removed, with no added candidate. Joe Turner's Come and Gone, Beaches and Buena Vista Social Club remained candidates. No source fetches were performed in these dry runs.

After rehearsing the plans on the disposable local copy, the acceptance audit exits 0 with 178 findings: 7 high, 18 medium, 153 low. Broadway running/previews coverage is 30/30; orphan count is zero. The total commercial count remains 273 because one orphan was removed and one production added. `--strict` also passes with zero violations; its narrower checks do not block every advisory finding.

## Accuracy and remaining research

The original broad corrections are already on main. No replacement of those fixes was attempted. `git log -S 'isCommercialScope' --oneline -5 -- scripts/audit-commercial-data.js` found no prior scope fix. The corresponding orphan-action history search found the original checkpoint, not commercial support. Executing origin/main's audit source through Node's module loader reproduced the inflated all-market denominator, and its default audit still exited 0. The card's workflow-status command failed before and after with the same missing-gh-auth error, despite the independently verified successful weekly run above.

Spot checks support retaining the announced recoupments for [The Piano Lesson](https://playbill.com/article/2022-broadway-revival-of-the-piano-lesson-announces-recoupment) and [The Outsiders](https://playbill.com/article/the-outsiders-has-recouped-on-broadway). Playbill search results supported those headlines; full article requests returned 403, so these were limited checks, not fresh article-level verification. [Broadway Journal's August 2023 report](https://www.broadwayjournal.com/p/solo-shows-deliver-as-aspiring-blockbusters-struggle) describes distributions and conditional tax-credit repayment for Just for Us. It does not establish a final outcome, so TBD remains.

The 18 closed-show TBD rows still requiring outcome evidence are: ragtime, cats-the-jellicle-ball, proof, leopoldstadt-2022, just-for-us, dog-day-afternoon, joe-turners-come-and-gone, the-fear-of-13, titanique, celebrity-autobiography, beaches, a-dolls-house-2023, death-of-a-salesman-2022, good-night-oscar-2023, macbeth-2022, take-me-out-2022, peter-pan-goes-wrong-2023, the-minutes-2022. Missing recoupment announcements and model estimates were not used to invent final outcomes.

Seven announced recoupments have modelRecouped=false: mj, the-outsiders, romeo-juliet-2024, kimberly-akimbo-2022, gutenberg, the-lehman-trilogy-2021 and the-piano-lesson-2022. These require sourced model-input diagnosis, not changes to the announced facts or suppression of the audit. Four old estimatedRecoupmentDate values remain on Gatsby, Stranger Things, Buena Vista Social Club and Operation Mincemeat. The audit also reports 120 source-quality, 12 methodology, 15 nonprofit-classification, one financial-sanity and one recoupment-percentage advisory. Those counts are not 149 independently established factual errors.

The existing seasonal coverage report reports 140/141 eligible recent-season records and 115/141 resolved outcomes before these plans; Waitress 2021 is researched but awaiting human review. Those eligibility rules require at least eight weeks and differ from the running-show coverage calculation. Wanted's two days of previews do not make it eligible for that historical measure.

## Verification and cost

- `node scripts/audit-commercial-data.js`: PASS before and after; findings and record counts above.
- `node scripts/audit-commercial-data.js --strict`: PASS, `0 violations` after local rehearsal.
- `node scripts/apply-commercial-pending.js --all --dry-run --no-source-verify`: PASS before and after; `would apply 17, skip 31` becomes `would apply 16, skip 32`, only 860 differs.
- `node --test --test-timeout 300000 scripts/lib/orphan-key-action.test.mjs tests/unit/commercial-coverage.test.mjs tests/unit/commercial-pending-identity.test.mjs tests/unit/commercial-source-verify.test.mjs tests/unit/merge-commercial-data.test.mjs tests/unit/commercial-apply-gate.test.mjs scripts/lib/classify-stale-closure.test.mjs tests/unit/pending-fix-plans.test.mjs`: PASS, 185 tests, 0 failures.
- Related-file sweep: 263 pass, 13 fail. All 13 failures reproduced with changed production files temporarily restored to origin/main: missing cheerio, next or js-yaml, plus an unrelated missing Grinch synopsis. The additional commercial-publish-gate test also failed on origin/main for missing js-yaml.
- `node scripts/check-workflow-run-status.js --workflow=commercial-weekly.yml --expect=success`: FAIL, `To get started with GitHub CLI, please run: gh auth login`. Public REST run history independently confirms success.
- `node scripts/check-grosses-integrity.js --weeks=9`: unavailable, `Cannot find module 'cheerio'`; freshness was verified from the real data and workflow history, but full history integrity was not certified.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`: ran. The repeat with `/tmp/bro4623-gauntlet` finished in 178 seconds with `lint-workflows=1`. Missing actionlint, acorn and glob block six gates: actionlint, audit-fetchpage-cleanup, audit-help-flag-safety, test-data-write-guard, alert-ledger-commit and ledger-coverage. The seventh failure, audit-venue-write-guard, reports 75 unbaselined sites on both this tree and origin/main, with identical findings after normalizing line numbers. All other gates passed. The unique scratch directory avoids other unattended workers overwriting shared /tmp/gauntlet logs and is removed after inspection.
- Additional audit-caller regression run: `node --test --test-timeout 300000 tests/unit/designation-thresholds.test.mjs tests/unit/recoupment-reconcile-gate.test.mjs tests/unit/commercial-pending-identity.test.mjs tests/unit/commercial-coverage.test.mjs scripts/lib/orphan-key-action.test.mjs`: PASS, 53 tests, 0 failures.
- `git diff --check`: PASS. No TypeScript or UI changes, so no TypeScript, lint or visual session commands were run. Generated tracked audit output is restored before handoff.

No new paid fetches, LLM calls, API calls, cron jobs or flags were added. Existing weekly/Friday/RSS callers reach the changed pending writer; existing weekly/Friday audit callers reach the new coverage function. The one-off workflow check used four public GitHub API requests. Data plans still require execution against the private core-data repository; changing this disposable copy does not publish them.
