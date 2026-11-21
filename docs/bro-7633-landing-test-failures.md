# BRO-7633: landing test refusals

The acceptance command, `node --test scripts/lib/land-merge-drivers.test.mjs`,
already passes all six tests on starting main (`cc4ccb3209`). It covers merge
drivers, not recoupment timing. No merge-driver change was needed.

The actual timing suite still gated mutable private data against historical
absolute MAE, inside-count and sample-count bounds. Its LIVE-DATA-LANE marker
excludes it from main's blocking test.yml batch, but land-gauntlet.sh and the
merged-tree gate still collect scripts/lib tests. Thus the marker alone did
not remove this source of landing refusals.

## Historical evidence and classification

| Evidence | Classification | Finding |
| --- | --- | --- |
| [39712940059, Land job](https://github.com/thomaspryor/Broadwayscore/actions/runs/39712940059/job/119612162017) | Incomplete test run plus timing assertion | ETIMEDOUT killed the merged run. The refusal also named the timing backtest. Changing a bound alone cannot clear an incomplete run. |
| [39720805540, Land job](https://github.com/thomaspryor/Broadwayscore/actions/runs/39720805540/job/119645406009) | Timing assertion plus a separate code/documentation invariant | The new-failure verdict named the timing test and CLOUD.md's byte cap. The historical title used a play MAE ceiling of 12; current main has 15. The logs do not identify the failing per-type assertion, so the title does not prove a musical MAE violation. |
| [43762173686, Checks job](https://github.com/thomaspryor/Broadwayscore/actions/runs/43762173686/job/132959216567) | Genuine branch regression | `review-write-safety.test.mjs::no new raw writes to review-text files outside documented exceptions` was NEW versus main. The scripts-lib gate had one new and one pre-existing failure. Preserve this guard. |
| [43783078525, Checks job](https://github.com/thomaspryor/Broadwayscore/actions/runs/43783078525/job/133024525857) | Genuine branch regression | `with-timeout.test.mjs::ratchet: no uncleared Promise.race timeouts in scripts/ or src/` was NEW versus main. Preserve this guard. |
| BRO-7583 evidence in `scripts/lib/run-push-audits.test.mjs` and `data/audit/recurrence-classes.json` | Unit test executing live repository audits | The recurrence report identifies BRO-5753, BRO-6319 and BRO-6527. Main already replaced the live audit execution with wiring checks and a guard. No duplicate fix here. |

The last two inspected Checks runs demonstrate that scripts-lib-tests failures
cannot all be treated as data drift or bypassed. The timing examples also
contain independent blockers, so removing the brittle assertion does not imply
those historical runs would have landed.

The card supplies the total of 65 runs / 61 branches and 82 hours, but not that
cohort's run IDs or its exact observation cutoff. The local alert ledger stores
the latest condition per branch, not every refusal: 46 scripts-lib conditions
have firstSeen on or after October 18. The public API returns 922 failed land
runs for October 18 through November 17, spanning many other failure classes.
Neither population reconstructs the card's denominator. The rows above are
verified examples and existing recurrence evidence, not a 65-run census.
Completing that census needs BRO-7631's original run inventory and refusal
details. No counts by root cause are inferred from these samples.

## Fix and effect

`scripts/lib/musical-model-backtest.test.mjs` now compares the calibrated model
with its type-specific options disabled on the same current corpus, for timing
and reported truth. It requires a positive MAE gain, no loss of inside coverage,
valid nonempty summaries, matching cohort sizes, and no newly unmodelled rows.
The existing play/musical isolation checks remain. This also removes the cousin
reported-truth absolute bounds and its fixed two-point gain floor.

The real comparison is `calibrationFailures()` in
`scripts/lib/backtest-calibration.js`, imported by the existing backtest suite.
Its offline class guard is `tests/unit/backtest-calibration.test.mjs`, collected
automatically. Reverting the caller to HEAD gives 3 pass / 1 fail; restoring the
fix gives 4 pass / 0 fail. The guard covers drift past the former bounds, lost
calibration, inside-count regressions, invalid summaries and mismatched counts.

Real-data results on this checkout:

| Mode / type | Rows | Live MAE | Disabled MAE | Live / disabled inside |
| --- | ---: | ---: | ---: | ---: |
| Timing musical | 88 | 13.4 | 18.5 | 59 / 55 |
| Timing play | 40 | 12.6 | 17.7 | 22 / 22 |
| Reported musical | 91 | 4.5 | 9.2 | 79 / 77 |
| Reported play | 45 | 2.3 | 11.6 | 41 / 37 |

The model and private data are unchanged. Comparing HEAD's model with the
working tree on the same data changes zero of 128 timing checkpoints and zero
of 136 reported-truth rows. Hamilton, Wicked and Book of Mormon are unchanged
timing examples; Hamilton, Wicked and Chicago are unchanged reported-truth
examples. No per-show commercial figures are included here.

RULE21 cousin search:

```sh
grep -rnE 'musicals hold MAE|assert\.ok\([^;]*(newMae|newInside)[[:space:]]*(<=|>=)|allOff\.newMae[[:space:]]*-' src/ scripts/ data/ tests/ .github/ --include='*.js' --include='*.mjs' --include='*.ts' --include='*.tsx' --include='*.yml' --exclude-dir=review-texts --exclude-dir=node_modules
```

The original suite contained both the timing and reported-truth instances;
after the fix the search finds no remaining matching absolute assertions.
`grep -rl 'backtest-calibration\|musical-model-backtest' tests scripts --include='*.test.*'`
identifies the new guard and existing suite for focused testing.

There are zero new paid fetches, LLM calls or network API calls per test run.
There are three additional local backtest subprocesses, with redundant git
archives avoided for disabled-option reported runs. The existing daily
check-corpus-drift.yml cron (08:20 UTC) still collects this suite through its
live-data lane; land also runs it. No workflow change is required.

Verification:

```sh
node --test scripts/lib/land-merge-drivers.test.mjs
# PASS: 6 tests, both before and after.
node --test --test-timeout 300000 tests/unit/backtest-calibration.test.mjs scripts/lib/musical-model-backtest.test.mjs
# PASS: 8 tests on real core data. The guard alone fails 1/4 with the caller reverted.
node --test --test-timeout 300000 scripts/lib/run-push-audits.test.mjs
# PASS: 34 tests, verifying the existing BRO-7583 fix (257 seconds).
node --test --test-timeout 300000 --test-name-pattern='BRO-3014 wiring|BRO-7583 guard' scripts/lib/run-push-audits.test.mjs
# PASS: 2 focused tests of that existing fix.
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
# PASS: lint-workflows=0, 375 seconds. Read lint-workflows.log; actionlint was absent locally.
git diff --check
# PASS. No TypeScript, UI, scoring-watchlist or content-quality files changed.
```

`git log -S 'musicals hold MAE' --oneline -5 -- scripts/lib/musical-model-backtest.test.mjs`
finds `d57e5ecf6` in the available history. Current main still contains the
absolute assertions; today's passing corpus is not proof of drift tolerance.
`git log -S 'BRO-7583' --oneline -5 -- scripts/lib/run-push-audits.test.mjs`
finds `4eabe15ef`; the live-audit execution fix is already present and was left
alone. Only the files for this fix and report remain modified.

REMAINING: classify all of the original 65 scripts-lib-tests runs using BRO-7631's run inventory; the verified samples above do not establish exhaustive category counts.
