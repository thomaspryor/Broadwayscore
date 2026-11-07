# BRO-5316: orphaned audit writes

Reviewed on 2026-10-17 against the scripts and workflow YAML in this checkout.
The card described 99 baseline entries; current main had 102. The existing
seven unit tests passed because all 102 findings were already baselined.

The file-level detector treats every audit-path literal as an output whenever
the script contains any write call. It also misses `for f in ...; git add "$f"`
staging and matches commands inside quoted heredocs. The 91 false positives or
deliberately local outputs have individual reasons in `EXEMPT` in
`audit-orphaned-audit-writes.js`. The existing landing-ledger exemption remains.
No detector algorithm, writer, workflow, private data or production record was
changed. Removing these findings does not repair the remaining persistence gaps.

## Retained baseline: 11 script/file pairs

Every output below is under `data/audit/`. Workflow names refer to
`.github/workflows/`. These are deliberately **not** exemptions. Workflow edits
were forbidden by the unattended-worker instructions for this run. Each row
needs a workflow staging fix, then `--update-baseline` in that same change.

| Script | Output | Writer evidence | Unstaged workflow and required follow-up |
| --- | --- | --- | --- |
| `audit-closing-dates.js` | `closing-date-discrepancies.json` | `fs.writeFileSync(AUDIT_FILE, ...)`, line 625 | `audit-closing-dates.yml`: add the report to the audit commit step. Currently only the scraper-spend ledger is staged. The core-data action does not copy this audit report. |
| `audit-cross-production.js` | `cross-production-audit.json` | Unconditional report write, lines 364-368 | `audit-cross-production-weekly.yml`: stage this report alongside `same-title-confusion.json`, which is additional output under `--dry-run`. The separate `audit-cross-production.yml` **already stages it**, after `cd data/audit` at lines 62-68. Retain this pair for the weekly workflow's real gap rather than exempting both invokers. |
| `audit-opening-dates.js` | `opening-date-discrepancies.json` | `fs.writeFileSync(AUDIT_FILE, ...)`, line 255 | `audit-opening-dates.yml`: stage the report in its audit commit step; only the scraper-spend ledger is currently staged. |
| `audit-outlet-registry.js` | `outlet-registry-gaps.json` | `saveAuditResults`, lines 1020-1029; invoked at line 1102 | `outlet-registry-baseline-maintenance.yml`: the `--json` call at line 68 also writes this report. The later `--update-baseline` returns before the report write, and the commit at line 113 stages only the two baselines. Include the gaps report in change detection and staging. |
| `audit-we-closing-dates.js` | `we-closing-date-discrepancies.json` | `fs.writeFileSync(AUDIT_FILE, ...)`, line 343 | `audit-we-closing-dates.yml`: stage the report with its public audit outputs. Currently stages the slug map and scraper-spend ledger only. |
| `enrich-card-acceptance.js` | `card-enrichment-log.jsonl` | `logEnrichmentWrite`, lines 680-713; called on actual enrichment writes at lines 1176 and 1364 | `card-verifiability-audit.yml`: persist the redacted enrichment log as well as the two verifiability reports. Both enrichment invocations can append it; currently neither stages it. |
| `opening-night-checklist.js` | `score-history.jsonl` | `recordDailySnapshot(targetShows, ...)`, line 516; real append in `lib/score-history-snapshot.js`, line 47 | `opening-night-checklist.yml` and `opening-night-broadcast.yml`: persist the snapshot written by each checklist invocation. History/remediation staging in the checklist workflow does not include score history. |
| `outlet-listing-poller.js` | `outlet-poller-rejected-urls.json` | Rejected-cache write, line 380 | `outlet-listing-poller.yml`: stage the rejection cache; pushing review texts and the spend ledger does not persist this public checkout file. Losing it also defeats cross-run rejection caching. |
| `sweep-we-aggregators.js` | `needs-human-review.json` | Review-queue write, line 375 | `sweep-we-aggregators.yml`: persist the manual-review queue. Neither the review-texts push nor the aggregator-archive push includes this audit path. |
| `sweep-we-aggregators.js` | `url-guess-hits.json` | Cumulative statistics write, line 321 | `sweep-we-aggregators.yml`: persist the accumulated URL-guess counts. Only the spend ledger is currently staged from the public audit directory. |
| `validate-restaurant-names.js` | `restaurant-validation.json` | Report write, line 149 | `generate-theater-tips.yml`: stage the validation report when present. The optional validation step receives `GOOGLE_PLACES_API_KEY` at lines 102-106, so this is a real write when the secret is configured, not a dead invocation. |

Some commit conditions inspect only the already-staged files. A follow-up must
include each added output in those conditions too, so a report-only change still
reaches the commit. Use the existing per-file staging helper where optional
outputs might be absent; do not force-add intentionally ignored reports.

## Boundaries checked

- `health-check.js`: 34 paths are detector inputs or explanatory hints. Its two
  other flagged paths are local caches. `checkDispatchOutcomes` returns before
  its state write without the ignored per-machine dispatch ledger (lines
  3326-3336). `buildExclusionSummaryHtml` returns its committed-daily-totals
  fallback before writing yesterday's local exclusion counts (lines 5010-5031).
- `audit-aggregator-gap.yml` already stages its listed audit outputs through
  the `for f` loop at lines 531-533. The critic-coverage, tour-audit, probe,
  follower-notification, arm-yield and cron-health workflows use the same
  explicit-list staging pattern. Their pair-specific exemptions name the
  actual workflow, rather than treating every audit file as covered.
- `audit-critic-coverage-bucket.js` reads the critic audit; newsletter scripts
  read the score stamps and gap reports; reconciliation reads the rejected URL
  cache; the digest snapshot reads the gap/reconciliation reports; Guardian
  staging reads reverse-discovery candidates. These are not their write targets.
- Manual-only baseline, verification and disposition writes are not reached by
  the flags their workflows pass. The Tony nominee command is inside a quoted
  issue-body heredoc, not executed by the awards workflow.
- Ignored bucket Markdown and score-integrity reports are consumed in the same
  run. The feedback run report is intentionally ignored and contains reader
  details; publishing it would violate the private-data rule.
- `push-core-data` copies its fixed core-file list, not arbitrary audit paths.
  The spend-ledger composite action stages only its telemetry ledgers. Neither
  action provides missing staging for the retained rows above.

The audit remains wired through `tests/unit/audit-orphaned-audit-writes.test.mjs`.
It reads repository sources only: zero new paid fetches, LLM calls or API calls
per invocation, including existing CI invocations. No schedules were changed.

## Verification

- `node scripts/audit-orphaned-audit-writes.js --json` before triage: 102 findings,
  all already baselined. After `--update-baseline`: 11 findings. Comparing the
  actual `run()` results confirmed 91 removed keys with reasons, zero added
  keys, and identical retained records (including workflow lists).
- Three real-source cases: `health-check.js` 36 to 0 (inputs/local caches),
  `audit-show-review-gap.js` 4 to 0 (already staged by the aggregator workflow's
  loop), `audit-closing-dates.js` 1 to 1 (real unstaged report, preserved).
- `node --test tests/unit/audit-orphaned-audit-writes.test.mjs`: 7 passed,
  0 failed before and after. The run with `--test-timeout 300000` also passed.
- `node scripts/audit-orphaned-audit-writes.js --check`: exit 0, 11 reviewed gaps.
- `git diff --stat origin/main HEAD -- scripts .github/workflows
  tests/unit/audit-orphaned-audit-writes.test.mjs`: empty. Starting main inputs
  match the pre-edit inputs that passed the card check. `git log -S
  'orphaned-audit' --oneline -5` also confirmed existing audit history; the
  passing test alone did not mean the baseline had been triaged.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  completed in 180 seconds. All available checks passed. The sole failing gate
  was `actionlint` (exit 127, `actionlint: command not found`), the missing-tool
  exception allowed by the worker instructions. Its log was inspected.
- `git diff --check`: passed. No TypeScript files were touched.
