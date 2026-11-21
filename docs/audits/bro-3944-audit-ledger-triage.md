# BRO-3944: single-writer audit ledger triage

Audited 2026-10-22 against scripts/lib/core-data-merge-registry.js: **153 single-writer entries, 144 under audit/, 9 outside it**. The card's original 143 count predates registry additions. Every audit entry appears exactly once below. Single-writer registration and workflow success are not persistence freshness checks.

## Selection and new guards

Add a guard where persisted, periodically refreshed observations determine a decision and a lost write can falsely report health or suppress the only alert. Do not equate a long-lived baseline, cooldown or quiet event stream with a stopped producer.

| Ledger | Real writer and reader | Guard and reason |
| --- | --- | --- |
| progress-watch-state.json | scripts/check-progress-stalls.js uses weekly-monitor-runner.js; health-check.js progressWatchResults reads surfaces | Pure progressLedgerAlert in scripts/lib/progress-watch.js reads the pre-write lastRunAt and observations. Warn after 72h; detect gaps over 72h within a trailing seven days. Allow one hour of clock skew, reject missing/invalid observations. Queue depth zero is still sampled and is healthy. Persist priorLedgerAlert alongside today's sample; the existing daily audit-freshness table surfaces it through the credentialed health job's owner-alert-router path. Clear the carried finding only when the next pre-write history is healthy. The independent reader also catches a stopped writer at 72h warn / 120h error. It does not redispatch paid scoring. |
| commercial-data-history.json | scripts/audit-commercial-data.js saveCommercialHistory; health-check.js checkCommercialModelDrift | Pure commercialHistoryIssue in scripts/lib/commercial-model-drift.js checks the existing history before append, and the digest independently checks it before claiming stable. Weekly maximum 200h, with a newest-pair gap check: one missed week remains visible after the writer resumes; the next normal weekly pair clears it. Reject invalid/future/reversed dates. Existing health-check unrouted-row selection sends the warning through owner-alert-router, with the existing 72h filing deferral. No new workflow or router writer is needed. |

Thresholds allow scheduled-run lag while detecting multi-day/dropped-week persistence gaps. Historical data is not backfilled or rewritten: missing observations cannot be reconstructed reliably.

## Complete audit-path partition

### Existing guard (42)

No additional guard. These actionable views already check elapsed time, continuity, expiry, or missing observations. Guard sites: scripts/lib/digest-snapshots.js (digest snapshots); scripts/lib/audit-freshness-checks.js (nine original detector rows); scripts/health-check.js (opening-night history, corpus, census, coverage probe, lifetime sweeps and daily audit reports); scripts/lib/waltz-model-fit.js; scripts/lib/dmarc-analysis.js (windowEnd, not generatedAt); scripts/lib/reverse-discovery-freshness.js; scripts/lib/outlet-heartbeat-monitor-core.js; scripts/lib/gap-audit-freshness.js; scripts/check-arm-yield.js (missing observations are themselves dead/unobserved findings). Expiry prevents stale decisions for outlet-feed-reconcile; it is not an independent age alarm.

- `audit/health-digest-snapshot.json`
- `audit/open-backlog-acceptance-sweep.json`
- `audit/waltz-model-fit.json`
- `audit/imageless-scored-shows.json`
- `audit/provider-spend-daily.jsonl`
- `audit/provider-spend-snapshot.json`
- `audit/coverage-holes.json`
- `audit/star-band-drift.json`
- `audit/early-publish-dates.json`
- `audit/guard-audit-snapshot.json`
- `audit/notion-schedule-coupling.json`
- `audit/affiliate-health.json`
- `audit/trunk-status-snapshot.json`
- `audit/cross-outlet-attribution-drift.json`
- `audit/cv-wrongproduction-lifetime.json`
- `audit/fulltext-mentions-show-lifetime.json`
- `audit/slug-mismatch-lifetime.json`
- `audit/roundup-url-mismatch-lifetime.json`
- `audit/revival-unverified-lifetime.json`
- `audit/missed-broadcasts.json`
- `audit/stale-announced-shows.json`
- `audit/done-evidence-digest-snapshot.json`
- `audit/census-recall-status.json`
- `audit/opening-night-history.json`
- `audit/corpus-drift.json`
- `audit/ob-closing-candidates.json`
- `audit/same-title-confusion.json`
- `audit/slug-misroute-audit.json`
- `audit/daily-digest-snapshot.json`
- `audit/dmarc-summary.json`
- `audit/alert-sender-inventory.json`
- `audit/reddit-digest-snapshot.json`
- `audit/reverse-discovery-candidates.json`
- `audit/venue-date-mismatches.json`
- `audit/coverage-adversarial-probe-status.json`
- `audit/t1-silent-gaps.json`
- `audit/coverage-digest-snapshot.json`
- `audit/uncollected-live-reviews.json`
- `audit/outlet-feed-reconcile.json`
- `audit/arm-yield-ledger.jsonl`
- `audit/playbill-broadway-last-success.json`
- `audit/outlet-heartbeat.json`

### New guard (2)

Persisted history determines a decision. progress-watch-state supplies the only three-cycle rescore liveness signal; commercial-data-history supplies the daily model-drift verdict. See implementation and thresholds below.

- `audit/progress-watch-state.json`
- `audit/commercial-data-history.json`

### Intentional baseline or retired output (6)

No periodic freshness alarm. Baselines remain valid until deliberately replaced; the two concluded A/B experiments have no active writer. deploy-watermark is a successful-deploy regression baseline: pre-deploy-check.js intentionally retains an older baseline when proposed counts shrink. Its stale throttle permits a new write rather than skipping indefinitely. Clock age alone does not establish failure.

- `audit/outlet-registry-baseline.json`
- `audit/outlet-registry-junk-baseline.json`
- `audit/bundle-size-baseline.json`
- `audit/gate-cold-start-monitor-state.json`
- `audit/ticket-ab-monitor-state.json`
- `audit/deploy-watermark.json`

### Event, checkpoint, cooldown or escalation state (36)

No blanket age alarm. These files encode events or state that may legitimately stay unchanged: cooldowns expire at consumption, circuit breakers reevaluate current usage, checkpoints resume work, acknowledgments and deduplication remain valid without new events. Lost writes can duplicate work or delay secondary escalation; an unchanged timestamp is not proof of loss. health-check-history influences escalation after current checks have already been recomputed, so fresh current errors still reach the digest. email-gate-funnel-monitor-state retains secondary trend history, but its primary capture-collapse check measures the current analytics window; excluding an additional trend alarm is a priority choice, not a claim it has no historical reader.

- `audit/orphan-rescore-requeue-state.json`
- `audit/opening-night-sla-state.json`
- `audit/bd-circuit-breaker.json`
- `audit/processed-feedback.json`
- `audit/pending-bug-diagnoses.json`
- `audit/opening-night-completeness-state.json`
- `audit/opening-night-live-state.json`
- `audit/drift-state.json`
- `audit/sd-circuit-breaker.json`
- `audit/sb-circuit-breaker.json`
- `audit/broadway-source-coverage-state.json`
- `audit/off-broadway-source-coverage-state.json`
- `audit/ob-venue-counts.json`
- `audit/owe-last-promotion-ids.json`
- `audit/ob-todaytix-missing-state.json`
- `audit/playbill-verdict-sitemap-seen.json`
- `audit/playbill-verdict-rejected-pages.json`
- `audit/flag-parity-monitor-state.json`
- `audit/opening-night-express-completed.json`
- `audit/processed-review-submissions.json`
- `audit/reverse-discovery-state.json`
- `audit/we-last-promotion-ids.json`
- `audit/gap-audit-checkpoint.json`
- `audit/t1-silent-gap-alerts.json`
- `audit/t1-coverage-ledger.json`
- `audit/t1-coverage-digest-state.json`
- `audit/t1-coverage-ack.json`
- `audit/t1-outlet-breaker.json`
- `audit/t1-recovery-state.json`
- `audit/critic-coverage-cooldown.json`
- `audit/outlet-heartbeat-state.json`
- `audit/cron-health-state.json`
- `audit/email-gate-funnel-monitor-state.json`
- `audit/follow-send-checkpoint.json`
- `audit/health-check-history.json`
- `audit/we-rejected-candidates.json`

### Companion to guarded decision view (13)

No duplicate domain alarm. These outputs share a producer or actionable view with an existing guard. They are not individually proven fresh by that guard. Examples: check-provider-spend.js writes the aggregate with its guarded billing ledger/snapshot; zero-call days legitimately produce no aggregate rows. Corpus summary, census status, DMARC summary, reverse-discovery candidates, coverage probe status, coverage digest and outlet heartbeat carry the relevant health signal. The policy is to guard the decision view rather than alert on each sibling file.

- `audit/scraper-spend-daily-agg.jsonl`
- `audit/done-evidence-audit.json`
- `audit/serp-census-recall.json`
- `audit/churn-merge-coverage.json`
- `audit/dmarc-report-ledger.jsonl`
- `audit/review-evidence.json`
- `audit/coverage-adversarial-probe.json`
- `audit/show-review-gap.json`
- `audit/t1-coverage-signals.json`
- `audit/t1-coverage-stats.json`
- `audit/critic-coverage-audit.json`
- `audit/critic-coverage-buckets.json`
- `audit/theatr-coverage.json`

### Current decision recomputed by caller (16)

No new historical freshness guard. The producer or consuming check computes the current finding from live runs, source data, current scans or workflow outcomes; its saved report is an observation rather than an independent all-clear. Examples: health-check.js invokes ci-green-rate for a current verdict; its historical green streak breaks on a missing day. time-to-publish-sla.js alerts from its freshly computed report. Source-coverage writers validate the current parser result before reporting gaps. Collection, duplicate, non-review and venue-transfer reports come from same-run scans. A lost historical trend point is secondary to the fresh finding. This does not assert these reports have no readers.

- `audit/ci-green-rate.jsonl`
- `audit/time-to-publish-sla.json`
- `audit/workflow-run-coverage.json`
- `audit/commercial-data-audit.json`
- `audit/broadway-source-coverage-gaps.json`
- `audit/off-broadway-source-coverage-gaps.json`
- `audit/discovery-source-coverage.json`
- `audit/scoring-audit.json`
- `audit/brand-mentions.json`
- `audit/regional-serp-discovery.json`
- `audit/tour-stop-discovery.json`
- `audit/collection-coverage.json`
- `audit/creative-team-audit.json`
- `audit/cross-outlet-duplicates.json`
- `audit/non-review-audit.json`
- `audit/possible-venue-transfers.json`

### Diagnostic, delta or historical receipt (29)

No new alarm on report age. These hold debugging findings, manual triage artifacts, event deltas, receipts or secondary trend points, rather than the sole periodic health verdict. Some are generated each run; others legitimately have no new event. Their absence may reduce diagnostic detail, but does not justify a separate owner incident for every output. For example bundle-size history accompanies comparison of fresh build metrics to the intentional baseline; promotion logs accompany event state; scoring histories accompany fresh rebuild results.

- `audit/linear-archive-done.jsonl`
- `audit/wrong-article-adjudicated.json`
- `audit/autonomous-recheck-ledger.jsonl`
- `audit/stuck-card-closer.json`
- `audit/owe-promotion-log.jsonl`
- `audit/date-enrichment-corrections.json`
- `audit/enrich-off-broadway-dates-aborted.json`
- `audit/bundle-size-history.json`
- `audit/bww-roundup-unmatched.json`
- `audit/playbill-verdict-unmatched.json`
- `audit/cast-changes-diff.json`
- `audit/daily-snapshot.json`
- `audit/needs-human-review.json`
- `audit/rebuild-score-drift.json`
- `audit/scoring-audit-history.json`
- `audit/scoring-audit.md`
- `audit/remediation-log.jsonl`
- `audit/show-score-extraction-gaps.json`
- `audit/video-review-audit.json`
- `audit/we-promotion-log.jsonl`
- `audit/affiliate-link-probe.json`
- `audit/unknown-aggregator-outlets.json`
- `audit/we-gate-proving.json`
- `audit/deployed-coverage-diff.json`
- `audit/autoclear-shadow.jsonl`
- `audit/autoclear-shadow-report.json`
- `audit/show-changes-digest.json`
- `audit/social-tier-transitions.json`
- `audit/collection-coverage-history.json`

## Nine entries outside audit/

Out of this card's ledger scope; no additional audit-ledger guard.

| File | Reason |
| --- | --- |
| grosses.json | Primary weekly data with existing data-freshness monitoring, not an audit ledger. |
| critic-consensus.json | Derived show consensus, regenerated on source changes or missing entries, not a daily ledger. |
| audience-reviews-lbo.json | Audience source data, refreshed per show; not audit telemetry. |
| followers.json | Incremental subscriber state with overlap/watermark recovery, not a periodic all-clear. |
| subscribers.json | Same incremental subscriber state writer. |
| subscribers-westend.json | Same incremental subscriber state writer. |
| feedback-submitters.json | Event-driven submitter state; no event can be a valid quiet period. |
| critic-slug-aliases.json | Human-maintained alias map with no scheduled writer. |
| recoupment-calibration-anchors.json | Calibration reference state, not periodic telemetry. |

## Reproduction and validation evidence

- Before: node --test tests/unit/audit-ledger-staleness.test.mjs could not find the file. git ls-tree origin/main for that path is empty. git log -S audit-ledger-staleness --oneline -5 was attempted, but a missing promisor object could not be fetched into the read-only common git object store; the supplied fresh-main check also confirms absence. No claim that inaccessible history was searched successfully.
- Progress: replayed actual saved histories immediately before the September 22, September 27 and October 21 observations. Old writer emitted zero freshness alerts in all three. New guard alerts on the 119.2h and 96.8h gaps; the normal 23.8h interval remains healthy. Two of three alert decisions change; zero persisted records change. Today's real report is healthy. The actual writer --dry-run scanned the real review corpus: 2,380 actionable / 2,423 flagged, 34 blocked, 9 not scoreable.
- Commercial: compared the original function loaded from git show HEAD against the new function on actual history prefixes of 1, 7 and 10 rows. July 20 and September 26 snapshots previously passed and now warn as stale; the October 19 full-history contradiction warning is unchanged. Two of three verdicts change; zero persisted records change.
- Wiring: llm-ensemble-score.yml already invokes check-progress-stalls.js and stages data/audit/progress-watch-state.json; commercial-weekly.yml already invokes audit-commercial-data.js --write-history. health-check.js already calls checkAuditFreshness and computeCommercialModelDriftStatus; its selectUnroutedVisitorRows loop routes the commercial warning. Tests require the real scripts/lib functions.
- Cost: zero new paid fetches or LLM calls. Both writers add zero direct API calls. Their new failing verdicts enter the existing daily health job's router and 72h deferred filing path. Existing owner-alert-router deduplication and optional Linear filing apply; their API count depends on incident state. The scoring snapshot step lacks LINEAR_API_KEY, so it carries the pre-write finding to the already credentialed health job rather than becoming a new router caller. Neither repair dispatches a paid workflow.

## Maintenance convention

For a newly registered single-writer audit ledger, identify the actual writer, the decision reader and whether a quiet ledger is valid. Choose an existing actionable-view guard, a pre-write history check plus independent reader, or document the reason no clock-age guard is appropriate. Do not infer persistence from a green run, file mtime, or this run's newly stamped date. Reassess a diagnostic exemption if a new reader starts using it for decisions.

### Commands and results

The acceptance command initially failed because its file was absent; after the change it passes all 14 cases.

```sh
node --test tests/unit/audit-ledger-staleness.test.mjs
# tests 14; pass 14; fail 0

node --test --test-timeout 300000 tests/unit/audit-ledger-staleness.test.mjs tests/unit/progress-watch.test.mjs tests/unit/rescore-actionable-depth.test.mjs tests/unit/rescore-queue-depth.test.mjs tests/unit/llm-ensemble-score-reviews-workflow.test.mjs tests/unit/scoring-lane.test.mjs tests/unit/audit-freshness-checks.test.mjs scripts/lib/commercial-model-drift.test.mjs scripts/lib/audit-workflow-hygiene-rules.test.mjs scripts/lib/api-fallback-writer-drift.test.mjs scripts/tests/health-check-sweep-staleness.test.mjs tests/unit/health-check-repeat-failures.test.mjs tests/unit/designation-thresholds.test.mjs tests/unit/commercial-strict-gate-dedupe-order.test.mjs tests/unit/recoupment-reconcile-gate.test.mjs
# Initial run: tests 249; pass 249; fail 0. Re-run after credential-routing fix below.

node --test --test-timeout 300000 tests/unit/audit-ledger-staleness.test.mjs tests/unit/progress-watch.test.mjs
# Initial focused check: tests 26; pass 26; fail 0

node scripts/check-progress-stalls.js --dry-run
# exit 0; real queue: 2380 actionable, 2423 raw, 34 blocked, 9 not scoreable

node scripts/audit-commercial-data.js --write-history
# exit 0; actual history 10 -> 11 rows, prior rows unchanged
# Both generated outputs restored byte-for-byte by a try/finally wrapper.

git diff --check
# exit 0
```

Independent read-only reviews found no blocking issues and each ran 21 targeted tests successfully. The triage/registry comparison found 144 paths, 144 unique, zero missing or extra. No TypeScript or UI files changed, so tsc, Next lint, build and visual checks are outside this change.

Final credential-routing verification repeated the exact 15-file focused command above after removing direct router calls from the scoring writer: **250 tests passed, zero failed**. The exact acceptance command passed **14 tests, zero failed**. The new writer-to-digest regression proves that a fresh lastRunAt preserves the pre-write finding and that a healthy following run clears it.

The real progress writer also ran without --dry-run on a disposable copy of the real state using --state=data/audit/.bro-3944-progress-state.json: exit 0, 30 retained observations, priorLedgerAlert=null. The copy was deleted in finally. September 22/27 replay through actual decideProgress followed by evaluateAuditFreshness returns warn after writing; October 21 returns ok. Inputs remain unchanged.

Changed files: .gitignore; scripts/check-progress-stalls.js; scripts/audit-commercial-data.js; scripts/lib/progress-watch.js; scripts/lib/commercial-model-drift.js; scripts/lib/audit-freshness-checks.js; scripts/lib/commercial-model-drift.test.mjs; tests/unit/audit-ledger-staleness.test.mjs; this triage document.

Final repository audit command:

```sh
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
# Completed in 207s; lint-workflows=1 solely because actionlint is absent:
# scripts/lib/land-gauntlet.sh: line 399: actionlint: command not found (exit 127)
# All other gates passed. The task explicitly permits ignoring missing actionlint.
# Credential audit: All routeAlert() steps have LINEAR_API_KEY in their env.
```

The final routing change received another independent review: 22 targeted tests passed, no blocking findings. Final git status contains only the nine intended files listed above; no data or workflow changes. Generated real-data outputs were restored byte-for-byte. The gauntlet temporary directory and verification logs were removed after their results were recorded here.
