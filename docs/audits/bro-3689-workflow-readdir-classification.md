# BRO-3689: workflow directory scan classification

## Follow-up verification, 2026-10-25

The existing acceptance check passes on starting main (`1ff6943ba5ff`):
63 tests, zero failures. All 32 classifications and the original guard fixes
are already present. A newer workflow enumeration in
`health-check.js:checkScheduledFailureStreak` still lacked the floor. Against
the real workflow directory restricted to zero or three entries it reported
`pass` with zero scheduled workflows checked; 49 entries also produced a
partial successful report. The added caller regression failed three cases
before the fix. This caller now uses the same guard as exempt-cron liveness,
preserving its `.yml` scope and existing error-row contract.
After the fix, `node --test tests/unit/workflow-readdir-guard-classification.test.mjs`
reports 67 passed and zero failures, including all four new caller cases.

The current real inventory contains 305 workflow files. Before/after probes of
the production caller, using that inventory with offline GitHub responses for
success, repeated failure, and lookup error, each visit the same 138 scheduled
workflows and produce identical results. Zero valid workflow records change.
Examples include `adjudicate-review-queue.yml`, `aggregator-url-watcher.yml`,
and `audit-aggregator-coverage.yml`. Incomplete inventories now produce an
error row before any API lookup. The offline responses test control flow;
they do not establish live workflow health.

The caller is wired into `computeCoreHealthResults()` and runs in the existing
daily digest. No new scripts, flags, paid fetches, LLM calls, API calls, or
cron invocations are introduced. The classification remains 14 verdict-risk
files and 18 informational files; the health-check entry covers three callers.

The related test search produced 2,440 passes, one skip, and seven failures:
four live-data/network failures reproduced with main's code, and three shell
tests initially passed to Node. All three shell tests passed when run with
Bash. The lint-workflows gauntlet reports all gates green (exit 0); actionlint
is unavailable locally. Its initial `/tmp/gauntlet` output directory disappeared
during concurrent tests, so the gate was rerun with an isolated output directory
and the saved log was read successfully. No new regression remains.

Follow-up verification after the runner reported 11 new failures:

- Reproduced with `node --test --test-timeout 300000 scripts/audit-missing-deps.test.mjs tests/unit/land-preflight.test.mjs tests/unit/workflow-readdir-guard-classification.test.mjs`: 100 passed, 11 failed.
- The failing fixtures produced the incomplete inputs. The hygiene CLI fixture
  had one workflow. The land-preflight repo builder copied the real orphan
  audit without its new guard dependencies and also had only one workflow.
  Both fixture builders now provide the production minimum of inert workflows;
  the repo builder also copies the guard and its floor-constant dependency.
  No production guard or audit rule changes were necessary.
- The same command now reports 111 passed, zero failed. The exact card command,
  `node --test tests/unit/workflow-readdir-guard-classification.test.mjs`,
  separately reports 63 passed, zero failed.
- `node --test --test-timeout 300000 scripts/audit-orphan-tests.test.mjs scripts/lib/workflow-glob-guard.test.mjs`: 23 passed, zero failed.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  all audits passed. The gate recorded exit 1 solely because actionlint was
  unavailable (`actionlint: command not found`, exit 127), the environment
  exception allowed by the runner instructions.
- Re-ran the real-data commands below before and after the fixture fix.
  `cmp` returned zero for all three output pairs: 291 workflow records,
  zero changed records or findings. The three named push-budget examples below
  each still have one push call; totals remain 258 calls and 242 flagged calls.
- `git cat-file -e origin/main:tests/unit/workflow-readdir-guard-classification.test.mjs`
  confirms the acceptance path is absent on main. The bounded history check
  `git log origin/main..HEAD -S 'readWorkflowFilesOrFailClosed' --oneline -5`
  finds this branch's original fix, `73458890a55`.
- Existing callers remain the hygiene CLI subprocess and land-preflight's
  `checkTestRegistration`/`collectCiCoverage` path. Both changed test files are
  collected by `scripts/lib/unit-test-collection.js`; no scripts, flags, or
  production functions were added. Additional paid fetches, LLM calls, API
  calls, and cron invocations per run: zero.

Audited against the current checkout: 291 workflow files. All 32 files named
by the card are below. `verdict-risk` includes advisory checks: a warning-only
audit must still distinguish an incomplete scan from a clean result.
`informational` includes false-positive grep hits that do not enumerate workflows.

The verdict producers use `readWorkflowFilesOrFailClosed()` before filtering
for schedules, alerts, push steps, or other features. Its existing 50-file floor
detects missing, empty, and implausibly small trees. It does not prove that a
partial checkout with 50 or more workflows is complete. Existing extension
handling is preserved: callers that scanned both extensions pass `includeYaml`;
the actionlint wrapper and exempt-cron liveness scan retain their `.yml` scope.

| File | Classification | Scan and decision |
| --- | --- | --- |
| `scripts/audit-alert-reachability.js` | verdict-risk | `collectFindings` printed no unreachable alerts for zero workflows. Now throws before a verdict; CLI retains advisory exit 0 with an explicit incomplete-scan warning. |
| `scripts/audit-alert-senders.js` | verdict-risk | `collectFindings` recursively walks scripts and workflows, swallowing directory errors. Missing workflows could remove direct sender violations from the baseline comparison. Guard the workflow corpus before walking. |
| `scripts/audit-broadway-category-predicate.js` | informational | Recursive source scan; workflows appear only in documentation. The scan roots are src and scripts, not the workflow directory. |
| `scripts/audit-critic-outlets.js` | informational | Reads review-text directories, not workflows. Workflow references describe scheduling. |
| `scripts/audit-data-gate-heal-paths.js` | verdict-risk | `loadWorkflowFiles` supplies heal-path evidence for test.yml and corpus gates. An incomplete corpus changes heal-path verdicts. Guard before constructing the evidence list. |
| `scripts/audit-errexit-unguarded-substitution.js` | informational | Enumerates composite actions under .github/actions. Workflows appear in the explicit out-of-scope explanation, not an enumeration. |
| `scripts/audit-invisible-verification.js` | verdict-risk | `main` recursively scans several roots and only had a combined zero-file floor. Other roots could hide absent workflows. Guard the workflow corpus before walking. |
| `scripts/audit-notion-schedule-coupling.js` | verdict-risk | `scanWorkflowsForCoupling` returned ok:true after scanning zero workflows. Guard failure now follows the existing ok:false observation-error contract. |
| `scripts/audit-orphan-tests.js` | verdict-risk | `collectCiCoverage` delegates workflow enumeration to `executableWorkflowText`. Guard at the verdict producer before deriving execution coverage. The library also serves intentionally small fixtures; it stays unchanged. |
| `scripts/audit-outlet-registry.js` | informational | Enumerates review-text JSON files. Workflow references are usage comments. |
| `scripts/audit-push-retry-budgets.js` | verdict-risk | `main` derives timeout violations and --fail-on-job-timeout exit status from all workflows. Guard before counting calls or violations. |
| `scripts/audit-regex-patterns.js` | informational | Enumerates discover scripts and review-text JSON files. Workflow references describe the scheduled invocation, not an input glob. |
| `scripts/audit-reconcile-coverage.js` | verdict-risk | `main` explicitly skipped missing directories and printed clean for empty ones. Remove the missing-directory success path and guard before scanning push steps. |
| `scripts/audit-run-budget-coverage.js` | verdict-risk | `collectFindings` derived schedules, dispatch edges, and missing-budget warnings from an unchecked list. Guard before building the dispatch graph. |
| `scripts/audit-stale-flag-after-url-correction.js` | informational | Enumerates review-text files; workflows are only mentioned as callers. |
| `scripts/audit-test-yml-lib-deps.js` | informational | Enumerates library tests, then reads the single required test.yml file. No workflow enumeration; missing test.yml already throws. |
| `scripts/audit-workflow-hygiene.js` | verdict-risk | `main` computes blocking hygiene totals from workflow files. Guard before any advisory dependency inspection or blocking rule evaluation. |
| `scripts/audit-workflow-concurrency.js` | verdict-risk | `main` computes cancellation violations and then queue eviction risks. Guard before either verdict, not after graph construction. |
| `scripts/check-opening-night-readiness.js` | informational | Enumerates a show's review texts and reads the fixed check-cron-health.yml path with an explicit FAIL on read error. No workflow enumeration. |
| `scripts/classify-wrong-show.js` | informational | Enumerates review-text JSON files. Workflow references are scheduling comments. |
| `scripts/clear-stale-roundup-flags.js` | informational | Enumerates review-text JSON files. Workflow references are scheduling comments. |
| `scripts/dedupe-same-url-bylines.js` | informational | Enumerates show directories and review-text files. No workflow enumeration. |
| `scripts/gather-reviews.js` | informational | All directory enumerations read review texts. Workflow references describe callers and environment requirements. |
| `scripts/generate-mobile-show-details.js` | informational | Enumerates library sources and output shards. No workflow enumeration. |
| `scripts/health-check.js` | verdict-risk | Exempt-cron liveness, scheduled failure streaks, and never-run coverage could report pass or persist a zero-offender snapshot after an incomplete scan. Guard all three. A coverage read failure now produces an error health row and leaves the previous snapshot intact. |
| `scripts/lint-resend-calls.js` | verdict-risk | `main` recursively walks scripts, workflows, and src, swallowing unreadable roots. Guard workflows before determining there are no direct Resend callers. |
| `scripts/measure-scraper-usage.js` | informational | On-demand cost telemetry, no PASS/FAIL verdict. Already warns and uses a named fallback when derivation is empty or unreadable. Partial inventories can undercount telemetry; this is not a safety gate. |
| `scripts/verify-supabase-schema.js` | informational | Enumerates Supabase migrations. Workflows are documentation references. |
| `scripts/lib/autonomous-checks.js` | informational | Enumerates source directories when preparing isolated checks. A workflow path appears in an environment/defaults comment. No workflow enumeration. |
| `scripts/lib/merge-post-merge-test-gate.js` | informational | Enumerates test files, not workflows. Workflow changes select the required regression tests. No workflow inventory contributes to its verdict. |
| `scripts/lib/run-actionlint-if-present.js` | verdict-risk | When actionlint is installed and not explicitly waived, missing or empty workflows previously exited 0. Guard before invoking actionlint. Documented missing-binary and commit-tag skips remain explicit. |
| `scripts/lib/test-yml-manifest-paths.js` | informational | Enumerates test directories and reads the fixed test.yml file. No workflow enumeration. |

The acceptance test reads this classification and runs each verdict-risk entry
against missing, empty, three-file, and 49-file fixture inventories using the
real caller and shared guard. Health coverage exercises all three callers. It also
checks the real inventory and the opt-in extension behavior at the exact floor.
Existing fixture regressions use inert workflows to satisfy the production floor
without changing their schedule, dispatch, or test-execution assertions.

No paid fetches, LLM calls, or API calls are added. The new guard only reads the
local directory. Existing cron entrypoints keep their schedules and API budgets.

Verification used HEAD = origin/main = cceafee49e83470bb760de4652b9654af45cf49c
as the starting point. The acceptance test was absent there. Empty-directory
calls to alert reachability, schedule coupling, and run-budget coverage each
returned an empty successful report before the patch. The new fixtures reject
all three inputs as unobservable.

Real-data comparisons before and after the patch produced identical output
for `node scripts/audit-reconcile-coverage.js`,
`node scripts/audit-workflow-concurrency.js`, and
`node scripts/audit-push-retry-budgets.js --json`. All scanned 291 workflows;
zero workflow records or findings changed. The push-budget report still has
258 calls and 242 flagged calls. Examples retained in that report include
audit-aggregator-gap.yml, audit-cross-production-weekly.yml, and
check-opening-night-drift.yml.

The lint-workflows gauntlet passed all audits; its only failing component was
the unavailable actionlint executable (`actionlint: command not found`, exit
127). Full `git log -S` history inspection was unavailable because the partial
clone needs an object it cannot fetch into the read-only shared Git object
directory. The starting main check and direct reproductions above establish
that this checkout still had the bug.

Exact verification commands and results:

Missing on starting main:

```sh
node --test tests/unit/workflow-readdir-guard-classification.test.mjs
```

FAIL: Could not find the test file.

Guard and initial fixture updates:

```sh
node --test --test-timeout 300000 tests/unit/workflow-readdir-guard-classification.test.mjs scripts/lib/workflow-glob-guard.test.mjs scripts/audit-notion-schedule-coupling.test.mjs scripts/audit-orphan-tests.test.mjs tests/unit/run-budget-coverage-dispatch-graph.test.mjs
```

PASS: 120 tests, zero failures.

Fixture and health-row corrections:

```sh
node --test --test-timeout 300000 tests/unit/audit-workflow-hygiene-push-permission.test.mjs tests/unit/audit-workflow-hygiene-dispatch-permission.test.mjs tests/unit/audit-workflow-hygiene-shell-safety.test.mjs tests/unit/health-check-pass-rows.test.mjs tests/unit/workflow-readdir-guard-classification.test.mjs
```

PASS: 135 tests, zero failures.

Final acceptance:

```sh
node --test tests/unit/workflow-readdir-guard-classification.test.mjs
```

PASS: 63 tests, zero failures.

Final helper and reachability regression:

```sh
node --test --test-timeout 300000 scripts/audit-alert-reachability.test.mjs scripts/lib/workflow-glob-guard.test.mjs
```

PASS: 27 tests, zero failures.

Automatic CI collection:

```sh
node scripts/lib/unit-test-collection.js --min
```

PASS: includes tests/unit/workflow-readdir-guard-classification.test.mjs.

Repository audit:

```sh
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
```

FAIL: actionlint unavailable (exit 127); every other component passed.

<details>
<summary>Initial related regression run (77 files)</summary>

```sh
node --test --test-timeout 300000 scripts/audit-alert-reachability.test.mjs scripts/audit-alert-senders.test.mjs scripts/audit-notion-schedule-coupling.test.mjs scripts/audit-orphan-tests.test.mjs scripts/audit-run-budget-coverage.test.mjs scripts/health-check.test.mjs scripts/lib/audit-push-retry-budgets.test.mjs scripts/lib/bsc-runner.test.mjs scripts/lib/cloud-memory-reconcile.test.mjs scripts/lib/disk-space-digest.test.mjs scripts/lib/github-api-budget.test.mjs scripts/lib/health-row-probe.test.mjs scripts/lib/opening-date-contradiction.test.mjs scripts/lib/publish-date-provenance.test.mjs scripts/lib/push-retry-remediation.test.mjs scripts/lib/reverse-discovery.test.mjs scripts/lib/workflow-glob-guard.test.mjs scripts/tests/alert-sender-bypass.test.mjs scripts/tests/health-check-autofix-ci-gate.test.mjs scripts/tests/health-check-hours-ago.test.mjs scripts/tests/health-check-sweep-staleness.test.mjs scripts/tests/health-check-unmeasurable-rows.test.mjs scripts/tests/provider-spend-ledger-freshness-row.test.mjs tests/unit/actions-cache-runid-key.test.mjs tests/unit/alert-dispatch-streak.test.mjs tests/unit/api-approve-fix.test.mjs tests/unit/audit-freshness-checks.test.mjs tests/unit/audit-health-check-audit.test.mjs tests/unit/audit-imageless-scored-shows-push.test.mjs tests/unit/audit-push-retry-budgets-residual.test.mjs tests/unit/audit-push-retry-budgets.test.mjs tests/unit/audit-workflow-hygiene-batch-poll-timeout.test.mjs tests/unit/audit-workflow-hygiene-core-data-push.test.mjs tests/unit/audit-workflow-hygiene-dead-commit.test.mjs tests/unit/audit-workflow-hygiene-dispatch-permission.test.mjs tests/unit/audit-workflow-hygiene-dispatch-token.test.mjs tests/unit/audit-workflow-hygiene-push-permission.test.mjs tests/unit/audit-workflow-hygiene-push-timeout.test.mjs tests/unit/audit-workflow-hygiene-rebuild-timeout.test.mjs tests/unit/audit-workflow-hygiene-run-shorthand.test.mjs tests/unit/audit-workflow-hygiene-shell-safety.test.mjs tests/unit/audit-workflow-hygiene-stage-no-commit.test.mjs tests/unit/broadway-scorecard-submission.test.mjs tests/unit/ci-manifest-no-dated-probes.test.mjs tests/unit/corpus-audit-results.test.mjs tests/unit/cron-health-chronic-refresh-show-score.test.mjs tests/unit/digest-escalation.test.mjs tests/unit/health-check-batch-state.test.mjs tests/unit/health-check-bww-miss-ledger.test.mjs tests/unit/health-check-card-verifiability-vacuous.test.mjs tests/unit/health-check-census-recall.test.mjs tests/unit/health-check-ci-green-rate.test.mjs tests/unit/health-check-coverage-holes.test.mjs tests/unit/health-check-coverage-probe.test.mjs tests/unit/health-check-green-streak.test.mjs tests/unit/health-check-lottery-freshness.test.mjs tests/unit/health-check-main-red-streak-alert.test.mjs tests/unit/health-check-pass-rows.test.mjs tests/unit/health-check-repeat-failures.test.mjs tests/unit/health-check-tour-automation.test.mjs tests/unit/is-shared-checkout-shallow.test.mjs tests/unit/lint-workflow-guards-ledger-coverage-floor.test.mjs tests/unit/lint-workflow-guards-ledger-step-guard-floor.test.mjs tests/unit/lint-workflow-guards-swallowed-audit-writers-floor.test.mjs tests/unit/llm-ensemble-score-reviews-workflow.test.mjs tests/unit/ob-candidates-digest.test.mjs tests/unit/opening-night-checklist-push.test.mjs tests/unit/published-score-star-band.test.mjs tests/unit/reverse-discovery-freshness.test.mjs tests/unit/run-budget-coverage-dispatch-graph.test.mjs tests/unit/stale-announced-audit-scheduled.test.mjs tests/unit/test-file-locations.test.mjs tests/unit/test-manifest-integrity.test.mjs tests/unit/tours-to-you-coverage.test.mjs tests/unit/waltz-model-fit.test.mjs tests/unit/workflow-readdir-guard-classification.test.mjs tests/unit/worktree-gc-schedule-freshness.test.mjs
```

1019 tests: 1011 passed, eight failed. Seven failures were old one-workflow
CLI fixtures, and one was the health-row name. The corrected fixtures and
health row passed in the 135-test follow-up above.

</details>
