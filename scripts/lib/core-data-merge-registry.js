'use strict';
/**
 * Canonical registry of core-data files with real concurrent-write risk
 * (BRO-76). Single source of truth for "which files need push-race
 * reconciliation, and how" — replacing what used to be independently
 * hand-maintained (and drift-prone) lists in several places:
 *   - .github/actions/push-core-data/action.yml's CORE_FILES bash array
 *     (which files get synced to the private data repo at all) plus its
 *     bespoke per-file inline reconciliation blocks (which of those actually
 *     get reconciled on a push race)
 *   - scripts/lib/reconcile-merged-json.js's MANAGED array (public-repo
 *     surface, driven by scripts/lib/push-with-retry.sh)
 *   - scripts/lib/reconcile-coverage.js's MANAGED_BASENAMES (CI audit that
 *     checks a push-with-retry.sh-calling step opts in to reconciliation)
 * diary-shows.json was missing from all of the above for exactly this reason
 * before it was hand-added (issue #176) — a new multi-writer file has to be
 * remembered in N places, and it's easy to remember it in N-1.
 *
 * TWO DISTINCT SURFACES, because they push to two different repos:
 *   'private-core-data' — synced to the private broadway-scorecard-data repo
 *     via .github/actions/push-core-data/action.yml. Files listed in that
 *     action's CORE_FILES array. Reconciliation (when present) runs from
 *     scripts/lib/reconcile-core-data-registry.js, invoked by that action.
 *   'public-repo' — committed straight to THIS repo (data/*.json tracked in
 *     git here). Reconciliation runs through scripts/lib/push-with-retry.sh's
 *     resolve_conflicts(), via scripts/lib/merge-commercial-conflict.js and
 *     (for the non-conflicting-rebase case) scripts/lib/reconcile-merged-json.js.
 * A file can only be reconciled on the surface it actually pushes through —
 * registering it on the wrong one is a silent no-op (confirmed live during
 * this card's own planning: opening-night-sent.json/critic-registry.json/
 * grosses-history.json are gitignored in the public repo, so any public-repo
 * reconciliation logic for them can never fire).
 *
 * STATUS:
 *   'active'   — a generic merge function is registered and actually wired
 *                into that file's surface.
 *   'special'  — genuinely multi-writer and reconciled, but via bespoke logic
 *                that doesn't fit the generic {ours, remote} -> {merged, stats}
 *                shape (e.g. shows.json's per-FIELD reconciliation). Exists so
 *                the lint gate (scripts/audit-core-data-registry-coverage.js)
 *                doesn't flag a file that's actually covered, just not by this
 *                registry's mechanism.
 *   'deferred' — known multi-writer risk, NOT YET reconciled. Must carry a
 *                `deferredReason` and `followUp` so the lint gate can accept
 *                the gap as a deliberate, tracked decision instead of a
 *                silent omission — the whole point of the gate is to turn
 *                "forgot to reconcile this" into "explicitly decided not to,
 *                and here's the ticket."
 *   'single-writer' — appears CORE_FILES-adjacent but has only one real
 *                writer today; documented so the lint gate doesn't re-flag it
 *                after someone re-derives the same "is this multi-writer?"
 *                question this card's research already answered.
 */

const { mergeCommercialJson, mergePendingReview, mergeResearchQueue } = require('./merge-commercial-data');
const { mergeDiaryShows } = require('./merge-diary-shows');
const { mergeSocialPostHistory } = require('./merge-social-post-history');
const { mergeFeedbackLedger } = require('./merge-feedback-ledger');
const { mergeBwwRoundupLedger } = require('./merge-bww-roundup-ledger');
const { mergeScraperSpendLedger } = require('./merge-scraper-spend-ledger');
const { mergeOwnerEmailLog } = require('./merge-owner-email-log');
const { mergeCensusRecallTrend } = require('./merge-census-recall-trend');
const { mergeCoverageAdversarialProbeTrend } = require('./merge-coverage-adversarial-probe-trend');
const { mergeAwardsJson } = require('./merge-awards-json');
const { mergeOpeningNightSent } = require('./merge-opening-night-sent');
const { mergeCriticRegistry } = require('./merge-critic-registry');
const { mergeGrossesHistory } = require('./merge-grosses-history');
const { mergeReviewsJson } = require('./merge-reviews-json');
const { mergeExpressRetryQueue } = require('./merge-express-retry-queue');
const { mergeObVenueCandidates } = require('./merge-ob-venue-candidates');
const { mergeAlertLedger } = require('./merge-alert-ledger');
const { mergeAlertDigestQueue } = require('./merge-alert-digest-queue');
const { mergeAlertRouterAttempts } = require('./merge-alert-router-attempts');
const { mergeGuardEscalationState } = require('./merge-guard-escalation-state');
const { mergeBreakerTransitions } = require('./merge-breaker-transitions');

const CORE_DATA_MERGE_REGISTRY = [
  // ── public-repo surface (push-with-retry.sh) ──────────────────────────────
  { file: 'commercial.json', surface: 'public-repo', status: 'active', merge: mergeCommercialJson, format: 'json', newline: true },
  {
    file: 'commercial-pending-review.json',
    surface: 'public-repo',
    status: 'active',
    merge: mergePendingReview,
    format: 'json',
    newline: true,
    // BRO-2795 follow-up: this entry was already MANAGED/'active' with a
    // real per-slug union merge (mergePendingReview, used today by the LOCAL
    // rebase-conflict path — resolve_conflicts()), but had no apiFallbackMerge
    // flag, so push-with-retry.sh's Git Data API fallback disqualifier
    // (`isManaged(f) && !isApiFallbackMergeable(f)`) trips on it EVERY time it
    // changes — independently of the two circuit-breaker files this card
    // otherwise fixes. commercial-rss-poll.yml's own PUSH_RECONCILE_MERGED_JSON=1
    // does NOT cover this: that flag only wires the LOCAL post-rebase
    // reconcile pass, a completely different code path from the Git Data API
    // fallback (confirmed by reading push-with-retry.sh directly — an
    // assumption the original incident writeup got wrong). Genuinely
    // multi-writer across 5 workflows sharing the commercial-data-write
    // concurrency group (batch-commercial-research.yml, commercial-friday.yml,
    // commercial-rss-poll.yml, commercial-weekly.yml, deep-research-
    // commercial.yml — grepped 2026-09-04), same bar already accepted for
    // audit/alert-ledger.json (12 writers) and audit/alert-digest-queue.json
    // (8 writers) below. mergePendingReview has its own colocated test
    // coverage (tests/unit/merge-commercial-data.test.mjs) and already
    // defends against the resurrection bug that class of merge is prone to.
    apiFallbackMerge: true,
  },
  { file: 'commercial-research-queue.json', surface: 'public-repo', status: 'active', merge: mergeResearchQueue, format: 'json', newline: true },
  { file: 'diary-shows.json', surface: 'public-repo', status: 'active', merge: mergeDiaryShows, format: 'json', newline: false },
  { file: 'social-post-history.json', surface: 'public-repo', status: 'active', merge: mergeSocialPostHistory, format: 'json', newline: true },
  {
    file: 'audit/feedback-request-ledger.json',
    surface: 'public-repo',
    status: 'active',
    merge: mergeFeedbackLedger,
    format: 'json',
    newline: true,
    // BRO-345: process-feedback.yml's push-contention-only failures (7x in
    // 24h, all "All push attempts failed after N of 20 budgeted attempt(s)
    // (deadline)") were disqualified from the Git Data API fallback with
    // "touches a union-merge-MANAGED file (without apiFallbackMerge
    // coverage)" — this was that file. It already had real per-key merge
    // logic (mergeFeedbackLedger, task #1440) for the local rebase case-arm
    // path; `apiFallbackMerge: true` opts the SAME merge fn into push-via-
    // git-api.sh's fast path too, same pattern as audit/alert-ledger.json
    // below (BRO-2413).
    apiFallbackMerge: true,
    // Unlike the other public-repo entries, this file is reconciled ONLY via
    // push-with-retry.sh's resolve_conflicts() case arm (fires unconditionally
    // on an actual rebase/merge conflict) — it is NOT part of reconcile-
    // merged-json.js's opt-in post-rebase pass (PUSH_RECONCILE_MERGED_JSON=1),
    // which exists to catch the DIFFERENT case of a non-conflicting `-X theirs`
    // rebase silently dropping a hunk. Excluding it from activeEntriesFor()
    // keeps reconcile-coverage.js's gate from demanding the opt-in flag on
    // steps that only ever reach this file through the case-arm path.
    optInReconcile: false,
  },
  // BRO-3071 (2026-09-14): apiFallbackMerge added — already 'active' with a
  // real per-(ts,showId) union merge (mergeBwwRoundupLedger, task #698;
  // genuinely multi-writer since opening-night-poller.yml's concurrency
  // group is per-show_id, so concurrent shows' runs append to this shared
  // ledger in parallel) used today by the LOCAL PUSH_RECONCILE_MERGED_JSON
  // path — but missing this flag disqualified push-with-retry.sh's Git Data
  // API fallback for opening-night-poller.yml's "Commit poller backoff
  // state" step (same shape as commercial-pending-review.json/BRO-2795,
  // census-recall-trend.jsonl/BRO-2296, and coverage-adversarial-probe-
  // trend.jsonl above). Same merge fn opts into both paths, no new
  // reconciliation logic needed. (audit/serp-burst-ledger.json and
  // audit/serp-session-ledger.json, staged in the same step, remain
  // genuinely unregistered — see the "NOT added, deliberately" block above —
  // so this alone does not yet make that whole step fallback-eligible.)
  { file: 'audit/bww-roundup-miss-ledger.jsonl', surface: 'public-repo', status: 'active', merge: mergeBwwRoundupLedger, format: 'jsonl', apiFallbackMerge: true },
  {
    file: 'audit/express-retry-queue.json',
    surface: 'public-repo',
    status: 'active',
    merge: mergeExpressRetryQueue,
    format: 'json',
    newline: true,
    // opening-night-express.yml uses a PER-SHOW concurrency group (see its
    // own comment on `concurrency:`), so multiple shows opening the same
    // night dispatch concurrently and can each append a retry entry to this
    // file around the same time — same multi-writer shape as
    // social-post-history.json. Reconciled ONLY via the case-arm path (same
    // reasoning as feedback-request-ledger.json above); not opted into the
    // post-rebase reconcile pass since the case-arm fires unconditionally on
    // an actual conflict, which two near-simultaneous appends reliably cause.
    optInReconcile: false,
  },

  // ── public-repo, apiFallbackSafe entries (task: data-health-check.yml
  // push-race hardening, session 2026-08-22, incident run 32559247279) ──────
  // `status: 'single-writer'` alone is NOT sufficient to license push-with-
  // retry.sh's Git Data API fallback (a fail-closed, "ours wins outright"
  // whole-file overwrite on a CRITICAL-tier push path) — that status has
  // exactly one existing consumer today (core-data-registry-coverage.js's
  // presence check, which doesn't even branch on the value) and was verified
  // to a much looser bar ("no real race", e.g. grosses.json's two writers
  // sharing a concurrency group) than "safe for a live compare-and-swap
  // bypass" requires. `apiFallbackSafe: true` is a SEPARATE, narrower claim,
  // consulted ONLY by push-with-retry.sh's disqualifier check (via
  // reconcile-merged-json.js's API_FALLBACK_SAFE export below) — never by
  // activeEntriesFor() or any other existing consumer of this registry.
  // Required fields on every apiFallbackSafe entry:
  //   concurrencyGroup — the GitHub Actions `concurrency.group` of the ONE
  //     workflow that writes this file, so overlapping runs of that SAME
  //     workflow (workflow_dispatch racing its own cron, a retry racing the
  //     original) queue instead of racing each other into the fallback —
  //     without this, "ours wins outright" can silently let a stale run
  //     clobber a fresher one with no error anywhere (plan-review finding,
  //     4-way cross-reviewer agreement: user-impact/pre-mortem/gpt-5.4-mini/
  //     gemini-2.5-flash).
  //   verifiedBy — when/how the single-writer claim was checked (grep across
  //     ALL .github/workflows/*.yml, not just the one workflow's own
  //     comments — a plan-review reviewer caught data/audit/alert-digest-
  //     queue.json wrongly seeded as single-writer from exactly that mistake:
  //     its OWN comment in data-health-check.yml said "single writer" but 12
  //     other workflows also write it).
  // Grow this list ONE entry at a time, each independently verified the same
  // way — do NOT batch-add unaudited data/audit/* paths on the strength of
  // an in-workflow comment alone.
  //
  // TO ROLL BACK one entry: flip `apiFallbackSafe: true` to `false` (or
  // delete the field). The runtime behavior reverts immediately and safely —
  // reconcile-merged-json.js's API_FALLBACK_SAFE export and push-with-
  // retry.sh's disqualifier both treat an empty/absent flag as fail-closed
  // (ship-check finding: this is NOT a zero-file revert though —
  // core-data-merge-registry.test.mjs's "sanity: exactly the seeded
  // apiFallbackSafe entry" and api-fallback-writer-drift.test.mjs's
  // live-repo regression test both hardcode "expect >=1 entry" and will fail
  // loudly until updated to match — deliberately, so removing the last entry
  // is a reviewed two-line PR, not a silent, unnoticed policy change).
  //
  // ONE ENTRY IS NOT PURELY LOCAL (BRO-2588, 2026-08-31; position updated
  // BRO-471, 2026-09-14): the earlier "no other file touched" claim on this
  // rollback is no longer true for audit/autonomous-recheck-ledger.jsonl.
  // That flag is load-bearing for .github/workflows/data-health-check.yml's
  // "Commit acceptance recheck ledger" step, which BRO-471 repositioned to
  // run immediately after the script step that writes it — specifically
  // BECAUSE it is apiFallbackSafe, so it can safely sit ahead of the OTHER
  // apiFallbackSafe/apiFallbackMerge commit+push steps in that job without
  // poisoning their Git Data API fallback. Flipping this flag off would make
  // this step's OWN git-add unsafe to run non-last, re-opening BRO-2538's
  // stranded-commit cascade for every step after it. Rolling that one back
  // means also moving the step back to the end of the job. This is not left
  // to memory: scripts/lib/push-with-retry.stranded-commit-cascade.test.sh
  // PART B asserts the general property (every push-with-retry.sh-calling
  // step in that job stages only FALLBACK-ELIGIBLE paths — apiFallbackSafe
  // OR apiFallbackMerge, and never one the runtime disqualifier still vetoes
  // — UNLESS it is the last such step), so a flag-only rollback fails CI
  // loudly instead of quietly regressing the workflow.
  // BRO-3348 widened that from apiFallbackSafe-only: this sentence used to
  // say "only apiFallbackSafe", which had silently stopped matching the
  // runtime disqualifier when BRO-2413 taught it to accept apiFallbackMerge.
  {
    file: 'audit/health-digest-snapshot.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-22: grepped every .github/workflows/*.yml for the literal filename — only data-health-check.yml writes it (as of BRO-2529, 2026-09-16: its "Commit digest + coverage snapshots (apiFallbackSafe)" step); that workflow declares concurrency: {group: data-health-check, cancel-in-progress: false}, so overlapping runs queue rather than race.',
    note: 'the file scripts/autonomous-email.js:HEALTH_DIGEST_PATH reads to build the owner\'s daily digest email — the file whose lost push caused this task\'s originating incident (run 32559247279)',
  },
  {
    file: 'audit/ci-green-rate.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-09-20: grepped every .github/workflows/*.yml for the literal filename — only data-health-check.yml stages it (its "Commit digest + coverage snapshots (apiFallbackSafe)" step, the SAME step as health-digest-snapshot.json above); the only writer is scripts/ci-green-rate.js --record, spawned solely by scripts/health-check.js checkCiGreenRate() when isCI, i.e. inside that one workflow, which declares concurrency: {group: data-health-check, cancel-in-progress: false}. Append-only JSONL, one row per nightly run.',
    note: 'the nightly CI green-rate reading (the machine PASS/FAIL on "is main green" — the only thing allowed to say so); health-check.js\'s "Main: green rate" row reads it back for the "7d trend from Y%, day D of 14" line. Registered the day it was added, because staging it unregistered in the apiFallbackSafe step disqualified that step\'s Git Data API fallback (audit-push-retry-budgets advisory, run 35531905889).',
  },
  {
    file: 'audit/open-backlog-acceptance-sweep.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-09-25: grepped .github/ and scripts/ for the literal filename — the only writer is scripts/sweep-open-backlog-acceptance.js, invoked only by data-health-check.yml ("Commit open backlog acceptance sweep" step, BRO-4135); scripts/dispatch-watchdog.js and scripts/lib/linear-watchdog-source.js only READ it. That workflow declares concurrency: {group: data-health-check, cancel-in-progress: false}.',
    note: 'nightly open-backlog acceptance sweep report (BRO-4135). Its commit step is not the last push-with-retry step, so staging it unregistered failed push-with-retry.stranded-commit-cascade.test.sh Part B and turned main red (test.yml run 36083765218, BRO-4149).',
  },
  {
    file: 'audit/imageless-scored-shows.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-imageless-scored-shows',
    verifiedBy: '2026-08-22: grepped every .github/workflows/*.yml and scripts/*.js for the literal filename — only scripts/audit-imageless-scored-shows.js writes it, invoked only by audit-imageless-scored-shows.yml\'s "Commit audit ledger" step; that workflow now declares concurrency: {group: audit-imageless-scored-shows, cancel-in-progress: false} (added alongside this entry — it had none before) so its own cron and a manual workflow_dispatch queue instead of racing each other into the fallback.',
    note: 'card #1456 self-heal ledger (cooldown/escalation state for scored shows missing images) — its commit step was losing the local fetch+rebase+push race under main-branch churn on ~20 of its last 25 runs (confirmed via run history) before this fix',
  },
  {
    file: 'audit/progress-watch-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'scoring-reviews',
    verifiedBy: '2026-09-21 (BRO-2722): grepped every .github/workflows/*.yml and scripts/*.js for the literal filename — only scripts/check-progress-stalls.js writes it, invoked only by llm-ensemble-score.yml\'s "Snapshot progress-watch state" step, gated on github.event_name == \'schedule\' (never set by a workflow_dispatch input, so its concurrency group is always the bare default, never the -{rescore_reason} suffixed variant). That workflow declares concurrency: {group: scoring-reviews[-reason], cancel-in-progress: false}, and every writer invocation lands in the unsuffixed \'scoring-reviews\' group specifically, so overlapping scheduled runs queue instead of racing.',
    note: 'liveness snapshot read by health-check.js\'s progressWatchResults() — was staged unregistered via git-add-existing.sh\'s broad `data/audit/` glob in the "Check for changes" step on every scheduled run, disqualifying that run\'s "Commit and push changes" step from the Git Data API fallback and forcing it onto the slow fetch+rebase+push path (root cause of the BRO-2722 repeat-failure alert — run 34818414035, 2026-09-14, "Commit and push changes" exhausted all 5 retry attempts under main-branch push contention with the fallback disqualified).',
  },
  // 2026-08-23 follow-up (same originating incident, run 32625283171): the
  // apiFallbackSafe fix above only isolated health-digest-snapshot.json —
  // data-health-check.yml's "Commit health check + triage data" step still
  // bundled these 15 files (plus 4 genuinely multi-writer ones left in that
  // step) into ONE commit, and that commit still lost its push race and
  // hard-failed the job, re-firing the exact same "Daily Data Health Check
  // Crashed" alert the digest fix was meant to stop. All 15 verified via
  // scripts/lib/api-fallback-writer-drift.js's findWritingWorkflows() against
  // the real .github/workflows/*.yml files (not the inline comments alone,
  // learning from the alert-digest-queue.json mistake documented above):
  // each has exactly ONE writer (data-health-check.yml) sharing that
  // workflow's own concurrency group ('data-health-check',
  // cancel-in-progress: false). Moved into their own isolated commit+push
  // step ("Commit health check audit snapshots (apiFallbackSafe)") so they
  // get the same Git Data API fallback protection. BRO-352 (2026-09-14)
  // later merged that step with the former "Commit digest snapshot" step
  // (health-digest-snapshot.json's entry above) into one atomic commit —
  // the isolation that used to separate them was silently losing writes to
  // push-with-retry.sh's own reset-to-clean-diff step; see the merged
  // step's comment in data-health-check.yml for the full incident.
  {
    file: 'audit/health-check-history.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/time-to-publish-sla.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/workflow-run-coverage.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/provider-spend-daily.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/provider-spend-snapshot.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/scraper-spend-daily-agg.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-09-08 (BRO-3008 S0-T6): same writer/workflow/concurrency-group as its two siblings above (check-provider-spend.js, data-health-check.yml git-add block) — never rotated, appended once/day with idempotent day-replace.',
  },
  {
    file: 'audit/notion-schedule-coupling.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    // BRO-3431 reopen: without this entry, staging this file alongside its
    // siblings in "Commit health check audit snapshots (apiFallbackSafe)"
    // would leave it unregistered — push-with-retry.sh's disqualifier check
    // refuses the Git Data API fallback for the WHOLE outgoing diff when any
    // staged data/audit/ path lacks apiFallbackSafe/apiFallbackMerge
    // registration, so an unregistered new file degrades the fallback
    // protection for every OTHER file in that same commit step, not just its
    // own (adversarial Codex review caught this before it shipped).
    verifiedBy: '2026-09-15: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  // NOT registered: audit/digest-history.json. findWritingWorkflows()'s regex
  // match on data-health-check.yml's `git add data/audit/digest-history.json`
  // line initially looked like a 15th single-writer candidate, but a deeper
  // check (ship-check review, 2026-08-23) found NO script anywhere writes
  // this path — it's orphaned dead weight (the workflow's line has always
  // been a permanent no-op via `2>/dev/null || true`), not a real file this
  // job produces. Left un-isolated and un-registered; harmless either way
  // since it never has staged content, but registering it would misleadingly
  // claim "verified single-writer" for a file with zero writers.
  {
    file: 'audit/affiliate-health.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/linear-archive-done.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/trunk-status-snapshot.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/cross-outlet-attribution-drift.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/cv-wrongproduction-lifetime.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/fulltext-mentions-show-lifetime.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/slug-mismatch-lifetime.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/roundup-url-mismatch-lifetime.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/revival-unverified-lifetime.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-23: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check.',
  },
  {
    file: 'audit/missed-broadcasts.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: "2026-09-07 (BRO-2934): grep of .github/workflows/*.yml for check-missed-broadcasts.js + 'git add data/audit/missed-broadcasts.json' — 1 writer (data-health-check.yml), group data-health-check, cancel-in-progress: false. Same residual risk already accepted for audit/stale-announced-shows.json below: the CLI writer (scripts/check-missed-broadcasts.js) can also be run locally, and the concurrency group only serializes CI against CI. Accepted on the same grounds — the file is disposable telemetry regenerated in full by the next scheduled run, and it holds no state the alert ledger does not already own.",
  },
  {
    file: 'audit/stale-announced-shows.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-31 (BRO-2620): findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (data-health-check.yml), group data-health-check. RESIDUAL RISK (ship-check/Codex adversarial finding, same class already accepted for audit/autonomous-recheck-ledger.jsonl above): the CLI writer (scripts/audit-stale-announced-shows.js, including its --ack/--unack paths) can also be run locally by a human. The concurrency group only serializes CI against CI, not CI against a local run — a locally-pushed snapshot can be silently overwritten by the next CI run\'s Git Data API fallback. Accepted because the file is disposable telemetry regenerated fresh by the next scheduled run; --ack/--unack state lives in the separate acks file this entry does not cover.',
  },
  // BRO-2588 (2026-08-31): registering this file is what DISSOLVES BRO-2538's
  // "the ledger commit step must run LAST in data-health-check.yml" ordering
  // constraint — a constraint that directly contradicted BRO-386's own
  // acceptance property ("the ledger-commit step runs BEFORE the bulk commit
  // step"), leaving test.yml red on whichever of the two suites lost. The
  // cascade BRO-2538 worked around only exists because a stranded, UNPUSHED
  // commit from that continue-on-error step carried an UNAUDITED data/audit/
  // path into every later step's SCRIPT_ENTRY_HEAD diff. Audit the path and
  // there is nothing left to poison, so the step is free to sit wherever the
  // job wants it. See data-health-check.yml's "Commit acceptance recheck
  // ledger" header comment for the full history.
  {
    file: 'audit/autonomous-recheck-ledger.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-31 (BRO-2588): grepped every .github/workflows/*.yml AND all of scripts/ for the literal filename. Sole WRITER: scripts/autonomous-acceptance-recheck.js (appends through scripts/lib/autonomous-ledger.js:48 fs.appendFileSync), invoked only by data-health-check.yml\'s "Acceptance recheck (shadow mode)" step; data-health-check.yml is also the only workflow that git-adds the path. Every other reference is a READER or a non-writing mention: scripts/autonomous-email.js:435 (ledger.readEntries) and scripts/dispatch-watchdog.js:195 (fs.readFileSync) read it; scripts/freeze-ledgers.js:86 only names it inside a freeze record; scripts/lib/audit-ledger-merge-attrs.js:150 does not write it either, but it is NOT a throwaway mention: it deliberately EXCLUDES this file from the union-merge .gitattributes because autonomous-acceptance-recheck.js:199 enforcementState() reads rechecks[0].ts as the OLDEST recheck (trusting file order as chronological) and counts rechecks.length with no dedup key, and both feed shouldExitShadow() (scripts/lib/autonomous-recheck-core.js:294), which arms automatic card reopening. That workflow declares concurrency: {group: data-health-check, cancel-in-progress: false}, so overlapping runs of it queue rather than race. RESIDUAL RISK, accepted knowingly and NOT eliminated by this entry: apiFallbackSafe routes this path through scripts/lib/push-via-git-api.sh, whose semantics are ours-wins-outright (see its header, line ~41 \u2014 our version replaces whatever the current remote tip has for that path). The concurrency group serializes CI against CI, but NOT CI against a local run: if the owner runs `node scripts/autonomous-acceptance-recheck.js` on their own machine and pushes appended rows, the next CI run\'s Git Data API fallback can overwrite that path with its checkout-time copy plus its own rows, silently dropping the locally-appended ones and shifting both rechecks[0] and rechecks.length \u2014 the exact two inputs the merge-attrs exclusion above protects. This is the same order/count hazard, reached by a different route, so registering the file apiFallbackSafe trades a push-reliability win for a narrow CI-vs-local clobber window; it is safe only for the CI-only write pattern that is in place today.',
    note: 'shadow-mode RECHECK-AFTER verdict ledger written by scripts/autonomous-acceptance-recheck.js — append-only JSONL, one line per recheck run',
  },
  // BRO-3426 (2026-09-15): registering these two is NOT merely about making
  // their own push fast — it is about not BREAKING the steps after them.
  // push-with-retry.sh:2312 disqualifies the Git Data API fallback when the
  // outgoing diff contains ANY data/audit/ path that is not registered here,
  // and a continue-on-error commit step that fails to push leaves its commit
  // on local HEAD, where every LATER step's SCRIPT_ENTRY_HEAD diff picks it
  // up. That is exactly the poisoning BRO-2588 documents for
  // audit/autonomous-recheck-ledger.jsonl above — so shipping these two
  // unregistered would have silently forced every subsequent commit+push step
  // in data-health-check.yml onto the slow local rebase path. Caught by a
  // Codex adversarial review before it shipped, not after.
  {
    file: 'audit/done-evidence-audit.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-09-15 (BRO-3426): grepped every .github/workflows/*.yml, all of scripts/ and all of tests/ for the literal filename. Sole WRITER: scripts/audit-done-evidence.js:68 (writeJson, tmp-file + rename), invoked only by data-health-check.yml\'s "Done-evidence audit (shadow mode)" step; that same workflow is also the only one that git-adds the path (its "Commit done-evidence audit" step). There are NO readers of this file anywhere — the digest reads the SEPARATE snapshot file below, not this one; the only other references are the script\'s own USAGE text and a comment in scripts/lib/done-evidence-audit.js explaining why sandbox paths are scrubbed (precisely so this nightly-committed file does not diff on a random temp dir). data-health-check.yml declares concurrency: {group: data-health-check, cancel-in-progress: false}, so overlapping runs queue rather than race. Full-overwrite snapshot, never append-only: each run rewrites the whole document, so the ours-wins-outright semantics of push-via-git-api.sh cannot drop accumulated history the way it could for an append-only ledger. RESIDUAL RISK, same class knowingly accepted for audit/stale-announced-shows.json and audit/autonomous-recheck-ledger.jsonl above: the CLI writer can also be run locally by a human, and the concurrency group serializes CI against CI but not CI against a local run. Accepted on the same grounds — this is disposable telemetry regenerated in full by the next nightly run, not state that can lose history.',
    note: 'full shadow-mode verdict report written by scripts/audit-done-evidence.js — one entry per Done(14d)/In Review/In Progress card, rewritten whole each run',
  },
  {
    file: 'audit/done-evidence-digest-snapshot.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-09-15 (BRO-3426): same writer (scripts/audit-done-evidence.js:69), same invoking step and same `git add` line as audit/done-evidence-audit.json above — both files are written by the same run and staged together. One READER: scripts/lib/digest-snapshots.js:128 registers it as the `doneEvidence` SNAPSHOTS row, which scripts/send-morning-digest.js renders; reading never conflicts with the API fallback\'s ours-wins semantics. Same full-overwrite (not append-only) shape and the same residual local-vs-CI clobber risk accepted for the same reason.',
    note: 'the {generatedAt, bannerText, items, moreCount} view model send-morning-digest.js renders as the "Done-evidence audit" block',
  },
  // BRO-2699 (2026-09-07): outlet-registry-baseline-maintenance.yml's daily
  // cron exists specifically to keep these two baseline files current so
  // test.yml's "Audit outlet-registry gaps" --strict gate doesn't flap red
  // on organic new-critic-outlet growth (card #1766). Without apiFallbackSafe
  // it was doing the opposite: its commit touches an unaudited data/audit/
  // path, so push-with-retry.sh's disqualifier forced it onto the slow
  // local fetch+rebase+push path, which lost the race against main's
  // constant deploy-watermark/stage-latency churn on 4 of the last 8
  // scheduled runs (2026-09-02, 09-04, 09-05, 09-07 all failed at the push
  // step with "overall deadline 240s exceeded" per `gh run list
  // --workflow=outlet-registry-baseline-maintenance.yml`). Each loss left
  // the baseline stale until the next successful cron, and any real new
  // outlet appearing in review-texts during that window hard-failed
  // test.yml's Data Validation job on main exactly as BRO-2699 reported.
  {
    file: 'audit/outlet-registry-baseline.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'outlet-registry-baseline-maintenance',
    verifiedBy: '2026-09-07 (BRO-2699): grepped every .github/workflows/*.yml and scripts/ for the literal filename — sole writer is scripts/audit-outlet-registry.js\'s --update-baseline mode, invoked only by outlet-registry-baseline-maintenance.yml\'s "Maintain outlet-registry baseline (with burst guard)" step and committed by its own "Commit updated baseline" step (one `git add` line covering both files below). test.yml only READS it (via --strict). That workflow declares concurrency: {group: outlet-registry-baseline-maintenance, cancel-in-progress: false}, so its own cron racing a manual workflow_dispatch queues rather than races. RESIDUAL RISK (same class already accepted for audit/stale-announced-shows.json and audit/autonomous-recheck-ledger.jsonl above): the CLI writer (node scripts/audit-outlet-registry.js --update-baseline) can also be run locally by a human. The concurrency group only serializes CI against CI, not CI against a local run — a locally-pushed baseline could in principle be overwritten by the next CI run\'s Git Data API fallback. Accepted on the same grounds as those two entries: the file is a frozen-backlog snapshot regenerated in full by the next scheduled --update-baseline run, not append-only state that can lose history.',
    note: 'the frozen missing-outlet backlog scripts/audit-outlet-registry.js --strict diffs new corpus finds against — see that script\'s header for the baseline-diff design',
  },
  {
    file: 'audit/outlet-registry-junk-baseline.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'outlet-registry-baseline-maintenance',
    verifiedBy: '2026-09-07 (BRO-2699): same writer/commit step/concurrency group as audit/outlet-registry-baseline.json above — both files are written by the same --update-baseline call and staged in the same `git add` line. Same residual local-vs-CI risk accepted for the same reason (full-overwrite snapshot, not append-only state).',
    note: 'sentinel/reserved-word outletIds already accepted into the registry (e.g. "lets-note") — frozen so isJunkOutlet() suggestions don\'t re-flag them',
  },
  // BRO-2296 (audit-census-recall.yml losing its push race twice running,
  // 2026-08-31 and 2026-09-07 — same "overall deadline 240s exceeded" shape
  // already fixed for outlet-registry-baseline.json above): the weekly
  // cron's "Commit recall report + trend ledger" step bundles four files in
  // one commit. census-recall-trend.jsonl and scraper-spend-ledger.jsonl
  // already had a real merge fn for the LOCAL PUSH_RECONCILE_MERGED_JSON
  // path (see their 'active' entries below, now also flagged
  // apiFallbackMerge — same fix, applied where those entries live), but
  // census-recall-status.json and serp-census-recall.json were unaudited
  // data/audit/ paths — enough on their own to disqualify the Git Data API
  // fallback for the WHOLE commit (the fail-closed "any unaudited data/audit/
  // path" branch), so both runs fell back to the slow local fetch+rebase+push
  // flow and lost it against main's constant churn. The 2026-08-31 loss
  // additionally cost a real provider-outage verdict (health-check.js's
  // "Coverage: SERP census recall" digest check went stale as a result),
  // which is what filed this card.
  {
    file: 'audit/census-recall-status.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-census-recall',
    verifiedBy: '2026-09-13 (BRO-2296): grepped every .github/workflows/*.yml and scripts/ for the literal filename — sole writer is scripts/audit-serp-census-recall.js (STATUS_PATH), invoked only by audit-census-recall.yml\'s "Measure per-arm census recall" step and git-added by that same workflow\'s "Commit recall report + trend ledger" step; health-check.js only reads it. That workflow declares concurrency: {group: audit-census-recall, cancel-in-progress: false}, so its own cron racing a manual workflow_dispatch queues rather than races.',
    note: 'the verdict health-check.js renders as the "Coverage: SERP census recall" digest check — a full overwrite each run, not append-only state',
  },
  {
    file: 'audit/serp-census-recall.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-census-recall',
    verifiedBy: '2026-09-13 (BRO-2296): same writer/commit step/concurrency group as audit/census-recall-status.json above — both written by the same scripts/audit-serp-census-recall.js run and staged in the same commit step.',
    note: 'the full per-show recall report (OUT_PATH) — a full overwrite each run, not append-only state',
  },
  // BRO-2435 (opening-night-broadcast.yml "Commit orphan-rescore-requeue
  // state" hard-failing every run, retries-exhausted): unlike alert-
  // ledger.json (19 writers — see the "NOT added" note just below), this
  // file has exactly one. Split into its own commit+push step so it alone
  // gets the Git Data API fallback; alert-ledger.json stays on the slow
  // local fetch+rebase+push path in a separate step.
  {
    file: 'audit/orphan-rescore-requeue-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'broadcast-send',
    verifiedBy: '2026-08-26: grepped every .github/workflows/*.yml for the literal filename — only opening-night-broadcast.yml writes it; that workflow declares concurrency: {group: broadcast-send, cancel-in-progress: false}, so overlapping runs queue rather than race.',
  },
  // BRO-2670 (opening-night-checklist.yml "Commit audit data" hard-failing 6
  // of 8 runs, losing the attempt-history ledger and re-dispatching the same
  // workflow forever): split into its own commit+push step, same class as
  // the two entries above. opening-night-orchestrator.yml also invokes
  // scripts/opening-night-checklist.js / scripts/opening-night-sla-
  // dispatch.js (which write these paths locally), but grepping that
  // workflow's file for `git add`/commit/push shows it never stages either
  // path — findWritingWorkflows() (scripts/lib/api-fallback-writer-drift.js)
  // against every .github/workflows/*.yml confirms exactly one writer for
  // each.
  {
    file: 'audit/opening-night-history.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'opening-night-checklist',
    verifiedBy: '2026-08-31: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (opening-night-checklist.yml), group opening-night-checklist (moved from a non-serializing per-run-id job-level group to a fixed workflow-level one as part of this same fix — see that workflow\'s own concurrency: block comment).',
  },
  {
    file: 'audit/opening-night-sla-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'opening-night-checklist',
    verifiedBy: '2026-08-31: findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (opening-night-checklist.yml), group opening-night-checklist. Written by scripts/lib/opening-night-sla.js:saveSlaState(), also invoked (locally, not committed) by opening-night-orchestrator.yml.',
  },
  // BRO-2795 (commercial-rss-poll.yml hourly hard-failure, incident run
  // 33906734626): the "Commit data changes" step's git-add-existing.sh call
  // only names commercial-pending-review.json/commercial-rss-state.json, but
  // its stage-data-changes.sh call (no args) sweeps ALL of data/ minus the
  // fixed private-path exclusions — so these two provider circuit-breaker
  // state files, written by the two continue-on-error steps just before it,
  // ride along uninvited every time either breaker's numbers change. Both
  // being unaudited data/audit/ paths (not in this list) was enough on its
  // own to disqualify push-with-retry.sh's Git Data API fallback for the
  // WHOLE commit (the fail-closed "any unaudited data/audit/ path" branch).
  // (PUSH_RECONCILE_MERGED_JSON=1 does NOT make the two files the step DOES
  // name fallback-safe by itself — that flag only wires the LOCAL post-rebase
  // reconcile pass, a different code path from the Git Data API fallback's
  // disqualifier; commercial-pending-review.json needed its own
  // apiFallbackMerge fix, see that entry above.) The
  // local fetch+rebase+push flow then lost its own race against main's
  // commit churn 3 times running (push-with-retry.sh's own working-as-
  // designed budget exit), with no fallback left to catch it, and the job
  // hard-failed hourly from 2026-09-04 11:47Z. Excluding the breaker files
  // from the commit instead (the other option this card considered) was
  // rejected: both breakers exist specifically so their state PERSISTS to
  // main within the hour (see their own step comments in
  // commercial-rss-poll.yml) — every other chokepoint that reads
  // scrapingdog-caps.js / brightdata-caps.js needs the committed file, not a
  // value that resets every run. Registering them apiFallbackSafe keeps that
  // persistence AND restores the fallback.
  {
    file: 'audit/bd-circuit-breaker.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'commercial-data-write',
    verifiedBy: '2026-09-04 (BRO-2795): grepped every .github/workflows/*.yml and scripts/ for "bd-circuit-breaker"/"check-bd-breaker.js" — sole writer is scripts/check-bd-breaker.js, invoked only by commercial-rss-poll.yml\'s "Bright Data daily circuit-breaker check" step (test.yml only unit-tests the script in isolation, never commits). That workflow declares concurrency: {group: commercial-data-write, cancel-in-progress: false}, so overlapping runs (its own cron racing a workflow_dispatch) queue rather than race. 2026-09-07 (BRO-2960): still sole writer/same concurrency group — the ONLY change is that commercial-rss-poll.yml now commits this file in its own earlier "Commit breaker state" step (a second push-with-retry.sh call in the same job, right after the two breaker checks) instead of bundling it into the later "Commit data changes" step, so a failure on that later, larger commit no longer costs the breaker verdict its push.',
  },
  // BRO-345 (process-feedback.yml repeat-failure, 7x/24h 2026-09-06→08): both
  // files below are unaudited data/audit/ paths, sole writer process-
  // feedback.yml, committed together with audit/feedback-request-ledger.json
  // and audit/alert-ledger.json/alert-digest-queue.json (all already
  // fallback-eligible) in the same "Commit tracking file" step — but these
  // two, being unregistered, disqualified the Git Data API fallback for the
  // WHOLE commit (the fail-closed "any unaudited data/audit/ path" branch),
  // leaving only the slow local fetch+rebase+push flow. That flow then lost
  // its own race against main's commit churn on every attempt within the
  // 600s budget (confirmed across all 7 failing runs — 4-6 attempts each,
  // ending in "push-with-retry: overall deadline 600s exceeded"), hard-
  // failing the job every ~10min cron tick. Registering these two as
  // apiFallbackSafe restores the fallback for the whole commit.
  {
    file: 'audit/processed-feedback.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'process-feedback',
    verifiedBy: '2026-09-08 (BRO-345): findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (process-feedback.yml), group process-feedback (cancel-in-progress: false). Sole writer script: scripts/process-feedback.js. RESIDUAL RISK (same class as audit/stale-announced-shows.json/autonomous-recheck-ledger.jsonl/outlet-registry-baseline.json above): the concurrency group only serializes CI against CI, not CI against a local run — scripts/process-feedback.js needs ANTHROPIC_API_KEY/FORMSPREE_TOKEN from local .env, so a developer running it by hand and pushing could race a CI run. Unlike those disposable-telemetry files, a stale overwrite here would cause loadTracking() to re-see already-answered Formspree submissions as new, i.e. duplicate thank-you emails / duplicate bug-diagnosis issues — accepted knowingly given local pushes to data/audit/ already violate this project\'s worktree-discipline norms (low likelihood), not eliminated.',
  },
  {
    file: 'audit/pending-bug-diagnoses.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'process-feedback',
    verifiedBy: '2026-09-08 (BRO-345): findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (process-feedback.yml), group process-feedback (cancel-in-progress: false). Written by scripts/process-feedback.js and drained/rewritten by the same workflow\'s "Create Bug Diagnosis Issues" github-script step. Same CI-vs-local residual risk as audit/processed-feedback.json above: a stale local overwrite could resurrect an already-drained diagnosis and re-file its bug issue.',
  },
  // BRO-345 /what-else follow-up (2026-09-08): auditWorkflowText() over every
  // workflow found 82 commit steps sharing this exact disqualified-fallback
  // shape. Most are 24h-cadence audits with ample slack to land a push before
  // the 600s deadline, but these two run every 15-30min — the same exposure
  // class that caused process-feedback.yml's repeat-failure alert — so they
  // get fixed now rather than parked on the roadmap. Both verified single-
  // writer via findWritingWorkflows() with their own dedicated concurrency
  // group. The remaining ~78 daily-cadence steps are lower urgency and
  // tracked as a follow-up card rather than fixed inline here.
  {
    file: 'audit/opening-night-completeness-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'opening-night-completeness-check',
    verifiedBy: '2026-09-08 (BRO-345 what-else): findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (opening-night-completeness-check.yml), group opening-night-completeness-check (cancel-in-progress: false). Runs every 15min — the tightest cadence of any step found with this disqualification shape.',
  },
  {
    file: 'audit/opening-night-live-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'opening-night-completeness-check',
    verifiedBy: '2026-09-08 (BRO-345 what-else): findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (opening-night-completeness-check.yml), group opening-night-completeness-check (cancel-in-progress: false). Same "Commit state file" step as audit/opening-night-completeness-state.json above.',
  },
  {
    file: 'audit/drift-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'check-opening-night-drift',
    verifiedBy: '2026-09-08 (BRO-345 what-else): findWritingWorkflows() against real .github/workflows/*.yml — 1 writer (check-opening-night-drift.yml), group check-opening-night-drift (cancel-in-progress: false). Runs every 30min.',
  },
  {
    file: 'audit/sd-circuit-breaker.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'commercial-data-write',
    verifiedBy: '2026-09-04 (BRO-2795): grepped every .github/workflows/*.yml and scripts/ for "sd-circuit-breaker"/"check-sd-breaker.js" — sole writer is scripts/check-sd-breaker.js, invoked only by commercial-rss-poll.yml\'s "ScrapingDog daily circuit-breaker check" step (test.yml only unit-tests the script in isolation, never commits). Same concurrency group as bd-circuit-breaker.json above, same workflow. 2026-09-07 (BRO-2960): same "Commit breaker state" step move as bd-circuit-breaker.json above.',
  },
  {
    file: 'audit/corpus-drift.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'check-corpus-drift',
    verifiedBy: '2026-09-11 (BRO-447): grepped every .github/workflows/*.yml and scripts/ for the literal filename — sole writer is scripts/check-corpus-drift.js, invoked only by check-corpus-drift.yml\'s "Commit and push audit" step (scripts/check-progress-stalls.js and scripts/health-check.js only READ it). That workflow declares concurrency: {group: check-corpus-drift, cancel-in-progress: false}, so overlapping runs (schedule vs workflow_run vs workflow_dispatch) queue rather than race. Freshly-regenerated verdict every run — nothing to union.',
  },
  {
    file: 'audit/churn-merge-coverage.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'check-corpus-drift',
    verifiedBy: '2026-09-11 (BRO-447): grepped every .github/workflows/*.yml and scripts/ for the literal filename — sole writer is scripts/audit-churn-merge-coverage.js, invoked only by check-corpus-drift.yml (same job, same "Commit and push audit" step, same concurrency group as audit/corpus-drift.json above).',
  },
  // BRO-2285: commercial-weekly.yml's auto-apply job ("Commit applied data +
  // audit" step) and sweep-pending job ("Commit sweep results" step) were
  // losing the local fetch+rebase+push race under main's constant churn on
  // nearly every run for months (5/5 recent runs sampled 2026-08-08 through
  // 2026-09-12 failed at this exact step), and push-with-retry.sh's Git Data
  // API fallback was disqualified because these two files sat outside
  // API_FALLBACK_SAFE — the same "unaudited data/audit/ path" shape already
  // fixed for audit/outlet-registry-baseline.json (BRO-2699) above. A
  // workflow that never lands a successful push never reports `success`, so
  // check-cron-health.yml's "hours since the last SUCCESSFUL run" staleness
  // check flagged it chronic — the underlying failure is push contention, not
  // the cancellation-at-timeout class the card also found in batch-research
  // (fixed separately via scripts/lib/run-budget.js in batch-commercial-
  // research.js).
  {
    file: 'audit/commercial-data-history.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'commercial-data-write',
    verifiedBy: '2026-09-12 (BRO-2285): findWritingWorkflows() (scripts/lib/api-fallback-writer-drift.js) against real .github/workflows/*.yml — sole CI writer commercial-weekly.yml. Written only via `audit-commercial-data.js --write-history` (scripts/lib/commercial-model-drift.js), which that workflow\'s "Update commercial model drift history" step is the ONLY caller of (per .github/workflows/CLAUDE.md: "--write-history is only passed here"). commercial-weekly.yml declares concurrency: {group: commercial-data-write, cancel-in-progress: false}, so a workflow_dispatch retry queues behind the running schedule instead of racing it. RESIDUAL RISK (same class already accepted for audit/autonomous-recheck-ledger.jsonl and audit/stale-announced-shows.json above): `node scripts/audit-commercial-data.js --write-history` can also be run locally by a human. The concurrency group only serializes CI against CI, not CI against a local run — a locally-pushed history append can be silently overwritten by the next CI run\'s Git Data API fallback (adversarial review finding, BRO-2285). Accepted because this is a rolling weekly-cadence series regenerated from commercial.json\'s current state each run, not irreplaceable input; a lost local append can be re-run.',
  },
  {
    file: 'recoupment-calibration-anchors.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'commercial-data-write',
    verifiedBy: '2026-09-12 (BRO-2285): findWritingWorkflows() against real .github/workflows/*.yml — 2 CI writers (commercial-friday.yml, commercial-weekly.yml, both via scripts/reconcile-recoupment-claims.js), both declaring concurrency: {group: commercial-data-write, cancel-in-progress: false} — the multi-writer-but-shared-group escape hatch this module\'s checkEntry() exists for (same shape already accepted for commercial-pending-review.json\'s apiFallbackMerge entry above, which lists all 5 workflows sharing this exact group). RESIDUAL RISK (same class as audit/commercial-data-history.json above): `node scripts/reconcile-recoupment-claims.js` can also be run locally, and the concurrency group only serializes CI against CI. Accepted on the same grounds — reconcile-recoupment-claims.js regenerates this array from commercial.json\'s current recouped-claim state each run (scripts/reconcile-recoupment-claims.js:373), so a clobbered local run is regenerated fresh next time, not permanently lost.',
  },
  // BRO-2285 /what-else follow-up: scripts/audit-push-retry-budgets.js (run
  // post-fix) showed the two entries above were STILL not enough —
  // commercial-weekly.yml's "Commit applied data + audit" step bundles a
  // THIRD file, data/audit/commercial-data-audit.json, into the same
  // git-add-existing.sh call, and push-with-retry.sh's disqualifier is an
  // all-or-nothing check on the WHOLE staged diff: one unregistered file in
  // the same commit still disqualifies the other two from the API fallback.
  // Registering it closes the gap the fix would otherwise have silently left
  // open until the next chronic-staleness cycle.
  {
    file: 'audit/commercial-data-audit.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'commercial-data-write',
    verifiedBy: '2026-09-12 (BRO-2285 what-else follow-up), corrected 2026-09-12 after a follow-up codex review caught the invocation count wrong the first pass: findWritingWorkflows() against real .github/workflows/*.yml — 2 CI WORKFLOWS write this path (commercial-weekly.yml, update-commercial.yml), both declaring concurrency: {group: commercial-data-write, cancel-in-progress: false} — same multi-writer-but-shared-group escape hatch as recoupment-calibration-anchors.json above. Within commercial-weekly.yml specifically there are 3 sequential steps in the SAME auto-apply job invoking `node scripts/audit-commercial-data.js` (flagless, `--strict`, `--write-history`) plus update-commercial.yml\'s flagless call — 4 invocations total, not 2, but all 4 reach the same unconditional `fs.writeFileSync(OUTPUT_FILE, ...)` (scripts/audit-commercial-data.js:1184) and the 3 same-job steps cannot race each other (sequential, not parallel), so the workflow-level single-group claim still holds. RESIDUAL RISK (same class as the two entries above): the CLI writer can also be run locally. Accepted on the same grounds — OUTPUT_FILE is a full snapshot regenerated fresh from commercial.json\'s current state on every invocation, not appended/accumulated state.',
  },
  // BRO-3071 (2026-09-14, BRO-345 what-else sweep follow-up): the ~78 files
  // BRO-345's own comment above parked as "lower urgency, tracked as a
  // follow-up card". Re-running auditWorkflowText() found 60 remaining
  // disqualifying steps (others already closed by BRO-2699/2296/2435/2670/
  // 2795/2285/447 above) covering 85 files across 35 workflows, every one
  // independently verified single-writer via findWritingWorkflows() where its
  // static `git add`/`git-add-existing.sh` regex resolves the call site, or by
  // hand where it doesn't (the documented loop-staged-path idiom — `for f in
  // a b c; do git add "$f"; done` — used by ~9 of these workflows; see
  // audit-push-retry-budgets.js's own extractLoopStagedPaths for the same gap
  // in that sibling tool). Seven workflows below (check-cron-health.yml,
  // collection-coverage-report.yml, audit-creative-team.yml, audit-review-
  // quality.yml, audit-aggregator-coverage.yml) had NO concurrency group at
  // all before this change — added alongside their entries, same remediation
  // as BRO-2699/BRO-2670. audit-aggregator-coverage.yml's and update-deploy-
  // watermark.yml's commit steps also got split into two push-with-retry.sh
  // calls each (same BRO-2435 pattern) so the newly-safe file in each bundle
  // (possible-venue-transfers.json / deploy-watermark.json) isn't defeated by
  // its still-multi-writer bundlemate (aggregator-coverage.json / stage-
  // latency.jsonl — see the "NOT added, deliberately: genuinely multi-writer"
  // block further below). NOT covered here, deliberately: audit/mezzanine-
  // coverage.json (update-mezzanine.yml uses a per-run_id concurrency group
  // BY DESIGN — see that workflow's own comment; a real serializing group
  // would reintroduce the Cats 2026-04-07 dropped-dispatch incident, so this
  // file stays genuinely concurrent and unregistered) and audit/serp-burst-
  // ledger.json + audit/serp-session-ledger.json (opening-night-poller.yml's
  // concurrency group is scoped per-show/market, not global, and the file
  // itself is a single GLOBAL ledger — scripts/opening-night-poller.js's own
  // header comment already documents this as an accepted, bounded race
  // between concurrently-polling shows, not something this registry's
  // per-workflow-group bar can truthfully claim safe).
  {
    file: 'audit/broadway-source-coverage-gaps.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (update-show-status.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/broadway-source-coverage-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (update-show-status.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/discovery-source-coverage.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (update-show-status.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/ob-venue-counts.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (update-show-status.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/owe-venue-candidates.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (update-show-status.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/playbill-broadway-last-success.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (update-show-status.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/date-enrichment-corrections.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (enrich-off-broadway-dates.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/enrich-off-broadway-dates-aborted.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (enrich-off-broadway-dates.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/ob-closing-candidates.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (detect-ob-closings.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/ob-todaytix-missing-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (detect-ob-closings.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/same-title-confusion.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-cross-production-weekly.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/slug-misroute-audit.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'shows-json-writer',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-cross-production-weekly.yml), group shows-json-writer (cancel-in-progress: false).',
  },
  {
    file: 'audit/bundle-size-baseline.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'check-performance-${{ github.ref }}',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (check-performance.yml), group check-performance-${{ github.ref }}.',
  },
  {
    file: 'audit/bundle-size-history.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'check-performance-${{ github.ref }}',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (check-performance.yml), group check-performance-${{ github.ref }}.',
  },
  {
    file: 'audit/bww-roundup-unmatched.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'scrape-new-aggregators',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (scrape-new-aggregators.yml), group scrape-new-aggregators (cancel-in-progress: false).',
  },
  {
    file: 'audit/playbill-verdict-sitemap-seen.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'scrape-new-aggregators',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (scrape-new-aggregators.yml), group scrape-new-aggregators (cancel-in-progress: false).',
  },
  {
    file: 'audit/playbill-verdict-unmatched.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'scrape-new-aggregators',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (scrape-new-aggregators.yml), group scrape-new-aggregators (cancel-in-progress: false).',
  },
  {
    file: 'audit/cast-changes-diff.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'update-cast-changes',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (update-cast-changes.yml), group update-cast-changes (cancel-in-progress: false).',
  },
  {
    file: 'audit/daily-digest-snapshot.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'daily-digest',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (daily-digest.yml), group daily-digest (cancel-in-progress: false).',
  },
  {
    file: 'audit/daily-snapshot.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'daily-digest',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (daily-digest.yml), group daily-digest (cancel-in-progress: false).',
  },
  {
    file: 'audit/dmarc-report-ledger.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'finance-ingest',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (finance-ingest.yml), group finance-ingest (cancel-in-progress: false).',
  },
  {
    file: 'audit/dmarc-summary.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'finance-ingest',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (finance-ingest.yml), group finance-ingest (cancel-in-progress: false).',
  },
  {
    file: 'audit/flag-parity-monitor-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'check-flag-parity',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (check-flag-parity.yml), group check-flag-parity (cancel-in-progress: false).',
  },
  {
    file: 'audit/needs-human-review.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'rebuild-reviews',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (scoring-audit.yml), group rebuild-reviews (cancel-in-progress: false).',
  },
  {
    file: 'audit/rebuild-score-drift.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'rebuild-reviews',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (scoring-audit.yml), group rebuild-reviews (cancel-in-progress: false).',
  },
  {
    file: 'audit/scoring-audit-history.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'rebuild-reviews',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (scoring-audit.yml), group rebuild-reviews (cancel-in-progress: false).',
  },
  {
    file: 'audit/scoring-audit.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'rebuild-reviews',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (scoring-audit.yml), group rebuild-reviews (cancel-in-progress: false).',
  },
  {
    file: 'audit/scoring-audit.md',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'rebuild-reviews',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (scoring-audit.yml), group rebuild-reviews (cancel-in-progress: false).',
  },
  {
    file: 'audit/alert-sender-inventory.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'monitor-scheduled-email-count',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (monitor-scheduled-email-count.yml), group monitor-scheduled-email-count (cancel-in-progress: false).',
  },
  {
    file: 'audit/brand-mentions.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'brand-mention-monitor',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (brand-mention-monitor.yml), group brand-mention-monitor (cancel-in-progress: false).',
  },
  {
    file: 'audit/opening-night-express-completed.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'broadcast-send',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (opening-night-broadcast.yml), group broadcast-send (cancel-in-progress: false).',
  },
  {
    file: 'audit/processed-review-submissions.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'process-review-formspree',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (process-review-formspree.yml), group process-review-formspree (cancel-in-progress: false).',
  },
  {
    file: 'audit/reddit-digest-snapshot.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'reddit-engagement-digest',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (reddit-engagement-digest.yml), group reddit-engagement-digest (cancel-in-progress: false).',
  },
  {
    file: 'audit/regional-serp-discovery.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'discover-regional-serp-reviews',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (discover-regional-serp-reviews.yml), group discover-regional-serp-reviews (cancel-in-progress: false).',
  },
  {
    file: 'audit/remediation-log.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'opening-night-checklist',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (opening-night-checklist.yml), group opening-night-checklist (cancel-in-progress: false).',
  },
  {
    file: 'audit/reverse-discovery-candidates.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-reverse-discovery',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-reverse-discovery.yml), group audit-reverse-discovery (cancel-in-progress: false).',
  },
  {
    file: 'audit/reverse-discovery-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-reverse-discovery',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-reverse-discovery.yml), group audit-reverse-discovery (cancel-in-progress: false).',
  },
  {
    file: 'audit/review-evidence.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-reverse-discovery',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-reverse-discovery.yml), group audit-reverse-discovery (cancel-in-progress: false).',
  },
  {
    file: 'audit/show-score-extraction-gaps.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'refresh-show-score-opening-night',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (refresh-show-score-opening-night.yml), group refresh-show-score-opening-night (cancel-in-progress: false).',
  },
  {
    file: 'audit/venue-date-mismatches.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-provisional-venues',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-provisional-venues.yml), group audit-provisional-venues (cancel-in-progress: false).',
  },
  {
    file: 'audit/video-review-audit.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-video-reviews',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-video-reviews.yml), group audit-video-reviews (cancel-in-progress: false).',
  },
  {
    file: 'audit/we-last-promotion-ids.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'promote-we-aggregator',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (promote-we-aggregator.yml), group promote-we-aggregator (cancel-in-progress: false).',
  },
  {
    file: 'audit/we-promotion-log.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'promote-we-aggregator',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (promote-we-aggregator.yml), group promote-we-aggregator (cancel-in-progress: false).',
  },
  {
    file: 'audit/affiliate-link-probe.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (weekly-affiliate-report.yml), group data-health-check (cancel-in-progress: false).',
    note: 'job-level group on the link-integrity job (shared with data-health-check.yml by design, see that job\'s own comment) — not a workflow-level group, verified by direct read',
  },
  {
    file: 'audit/deploy-watermark.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'deploy-watermark-update',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (update-deploy-watermark.yml), group deploy-watermark-update.',
    note: 'job-level group on the update-watermark job',
  },
  {
    file: 'audit/theatr-coverage.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'theatr',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (update-theatr.yml), group theatr (cancel-in-progress: false).',
    note: 'shared with rotate-theatr-token.yml by design (token-rotation mutual exclusion) — that workflow does not write this file, verified by grep',
  },
  {
    file: 'audit/coverage-adversarial-probe.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'coverage-adversarial-probe',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (coverage-adversarial-probe.yml), group coverage-adversarial-probe (cancel-in-progress: false).',
  },
  {
    file: 'audit/coverage-adversarial-probe-status.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'coverage-adversarial-probe',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (coverage-adversarial-probe.yml), group coverage-adversarial-probe (cancel-in-progress: false).',
  },
  {
    file: 'audit/show-review-gap.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/unknown-aggregator-outlets.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/gap-audit-checkpoint.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/we-gate-proving.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/t1-silent-gaps.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/t1-silent-gap-alerts.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/t1-coverage-ledger.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/t1-coverage-digest-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/t1-coverage-signals.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/t1-coverage-stats.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/t1-coverage-ack.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/t1-outlet-breaker.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/deployed-coverage-diff.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/t1-recovery-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/autoclear-shadow.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/autoclear-shadow-report.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/coverage-digest-snapshot.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/uncollected-live-reviews.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-gap',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-gap.yml), group audit-aggregator-gap (cancel-in-progress: false).',
  },
  {
    file: 'audit/critic-coverage-audit.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-critic-coverage',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-critic-coverage.yml), group audit-critic-coverage (cancel-in-progress: false).',
  },
  {
    file: 'audit/critic-coverage-buckets.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-critic-coverage',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-critic-coverage.yml), group audit-critic-coverage (cancel-in-progress: false).',
  },
  {
    file: 'audit/critic-coverage-cooldown.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-critic-coverage',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-critic-coverage.yml), group audit-critic-coverage (cancel-in-progress: false).',
  },
  {
    file: 'audit/outlet-heartbeat.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-critic-coverage',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-critic-coverage.yml), group audit-critic-coverage (cancel-in-progress: false).',
  },
  {
    file: 'audit/outlet-heartbeat-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-critic-coverage',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-critic-coverage.yml), group audit-critic-coverage (cancel-in-progress: false).',
  },
  {
    file: 'audit/cron-health-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'check-cron-health',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (check-cron-health.yml), group check-cron-health.',
    note: 'concurrency group ADDED to this workflow by this change (previously had none)',
  },
  {
    file: 'audit/email-gate-funnel-monitor-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'monitor-gate-ab',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (monitor-gate-ab.yml), group monitor-gate-ab (cancel-in-progress: false).',
  },
  {
    file: 'audit/gate-cold-start-monitor-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    // false, not true: the writer-drift guard (scripts/lib/api-fallback-writer-drift.test.mjs)
    // re-verifies every apiFallbackSafe:true entry against the live workflows and
    // rightly found no writer once BRO-3422 (6817ae16c07) removed it — main went red
    // on 2026-09-15. A frozen file has no writer to be safe for.
    apiFallbackSafe: false,
    concurrencyGroup: 'monitor-gate-ab',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (monitor-gate-ab.yml), group monitor-gate-ab (cancel-in-progress: false). SUPERSEDED 2026-09-15: writer removed, see note.',
    note: 'FROZEN as of 2026-09-15: the gate-cold-start A/B concluded and monitor-gate-ab.yml no longer writes this file (its write step was removed) — kept in the repo as the historical readout, not actively single-written anymore despite the status above.',
  },
  {
    file: 'audit/ticket-ab-monitor-state.json',
    surface: 'public-repo',
    status: 'single-writer',
    // false, not true: same pattern as the gate-cold-start-monitor-state.json
    // entry above — the writer-drift guard re-verifies every apiFallbackSafe:
    // true entry against the live workflows and rightly found no writer once
    // BRO-3456 (912f84e7d43) concluded the ticket-single-button A/B and
    // removed its monitor-gate-ab.yml write step. main went red on
    // 2026-09-16. A frozen file has no writer to be safe for.
    apiFallbackSafe: false,
    concurrencyGroup: 'monitor-gate-ab',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (monitor-gate-ab.yml), group monitor-gate-ab (cancel-in-progress: false). SUPERSEDED 2026-09-16: writer removed, see note.',
    note: 'FROZEN as of 2026-09-16: the ticket-single-button A/B concluded (BRO-3456, card #392) and monitor-gate-ab.yml no longer writes this file (its write step was removed) — kept in the repo as the historical readout, not actively single-written anymore despite the status above.',
  },
  {
    file: 'audit/follow-send-checkpoint.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'send-follow-notifications',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (send-follow-notifications.yml), group send-follow-notifications (cancel-in-progress: false).',
  },
  {
    file: 'audit/show-changes-digest.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'send-follow-notifications',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (send-follow-notifications.yml), group send-follow-notifications (cancel-in-progress: false).',
  },
  {
    file: 'audit/social-tier-transitions.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'send-follow-notifications',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (send-follow-notifications.yml), group send-follow-notifications (cancel-in-progress: false).',
  },
  {
    file: 'audit/arm-yield-ledger.jsonl',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'check-arm-yield',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (check-arm-yield.yml), group check-arm-yield (cancel-in-progress: false).',
  },
  {
    file: 'audit/collection-coverage.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'collection-coverage-report',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (collection-coverage-report.yml), group collection-coverage-report.',
    note: 'concurrency group ADDED to this workflow by this change (previously had none)',
  },
  {
    file: 'audit/collection-coverage-history.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'collection-coverage-report',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (collection-coverage-report.yml), group collection-coverage-report.',
    note: 'concurrency group ADDED to this workflow by this change (previously had none)',
  },
  {
    file: 'audit/creative-team-audit.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-creative-team',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-creative-team.yml), group audit-creative-team.',
    note: 'concurrency group ADDED to this workflow by this change (previously had none)',
  },
  {
    file: 'audit/cross-outlet-duplicates.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-review-quality',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-review-quality.yml), group audit-review-quality.',
    note: 'concurrency group ADDED to this workflow by this change (previously had none)',
  },
  {
    file: 'audit/non-review-audit.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-review-quality',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-review-quality.yml), group audit-review-quality.',
    note: 'concurrency group ADDED to this workflow by this change (previously had none)',
  },
  {
    file: 'audit/possible-venue-transfers.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'audit-aggregator-coverage',
    verifiedBy: '2026-09-14 (BRO-3071 what-else sweep): findWritingWorkflows()-class check (scripts/lib/api-fallback-writer-drift.js; manual grep for loop-staged idiom where the static regex has a documented blind spot) against real .github/workflows/*.yml — 1 writer (audit-aggregator-coverage.yml), group audit-aggregator-coverage.',
    note: 'concurrency group ADDED to this workflow by this change (previously had none); commit step also split so this file\'s own push-with-retry.sh call no longer bundles the still-multi-writer aggregator-coverage.json',
  },

  // NOT added, deliberately (BRO-3071 what-else sweep, 2026-09-14): genuinely
  // multi-writer with DIFFERENT concurrency groups per writer — the
  // checkEntry()/concurrencyGroup escape hatch this file documents only
  // covers writers that share ONE group (the grosses.json shape); none of
  // these six do. Each would need a real per-key merge function (the
  // apiFallbackMerge pattern — see audit/guard-escalation-state.json above
  // for the precedent) before it could safely bypass push-with-retry.sh's
  // "ours wins outright" fallback. Out of scope for this sweep (which only
  // fixed already-single-writer files); tracked as a follow-up rather than
  // rushed:
  //   data/audit/aggregator-coverage.json — audit-aggregator-coverage.yml
  //     (daily cron, no group) + close-coverage-gaps.yml (no cron trigger
  //     found, no group). Lower urgency (daily/on-demand).
  //   data/audit/indexing-api-usage.json — 3 writers, 3 DIFFERENT groups
  //     (check-seo-health.yml: seo-health, weekly; opening-night-
  //     broadcast.yml: broadcast-send, daily; update-show-status.yml:
  //     shows-json-writer, daily).
  //   data/audit/last-promotion-ids.json, data/audit/ob-promotion-log.jsonl
  //     — add-requested-show.yml (workflow_dispatch only, dedicated group
  //     but a DIFFERENT one — see that workflow's own comment on why it's
  //     not shared with scrape-new-aggregators.yml) + scrape-new-
  //     aggregators.yml (daily cron, group scrape-new-aggregators).
  //   data/audit/ob-aggregator-rejections.json — audit-cross-production-
  //     weekly.yml (weekly, group shows-json-writer) + scrape-new-
  //     aggregators.yml (daily, group scrape-new-aggregators) — different
  //     groups.
  //   data/audit/stage-latency.jsonl — opening-night-checklist.yml (hourly,
  //     group opening-night-checklist) + update-deploy-watermark.yml (fires
  //     on every production deploy, group deploy-watermark-update) —
  //     different groups, and the highest-cadence of the six (bursty
  //     deploys can fire several times/day). Bundled with audit/deploy-
  //     watermark.json (now apiFallbackSafe, see above) in the same commit
  //     step; the step was split so deploy-watermark.json's own push isn't
  //     defeated by this file staying on the slow path.
  // NOT added, deliberately: data/audit/opening-night-latency-YYYY-MM-DD.json
  // — filename is date-stamped, and BOTH places that check apiFallbackSafe
  // membership (push-with-retry.sh's inline disqualifier and audit-push-
  // retry-budgets.js's classifyPushFallbackSafety) do exact-suffix
  // `.endsWith()` matching with no glob/prefix support. Extending that
  // shared, duplicated matching logic for one non-gating, continue-on-error
  // telemetry file isn't worth the blast radius — it stays on the slow path,
  // unchanged from before this fix.
  // BRO-2413: alert-ledger.json/alert-digest-queue.json/alert-router-
  // attempts.jsonl are genuinely multi-writer (12/8/3 writers respectively —
  // see the comment above this block) so `apiFallbackSafe` (which claims "no
  // merge needed") is still wrong for them. But unlike a MANAGED entry
  // without `apiFallbackMerge`, these three now carry a real merge function
  // AND opt into push-via-git-api.sh's fast path via `apiFallbackMerge:
  // true` — a distinct, narrower claim than `apiFallbackSafe`: "this file
  // has real reconciliation logic, safe to run inside the Git Data API
  // fallback's per-retry loop" rather than "no reconciliation needed at
  // all." push-with-retry.sh's disqualifier (the `isManaged(f) &&
  // !isApiFallbackMergeable(f)` check) and push-via-git-api.sh (which looks
  // these three up via findEntry() and runs their merge fn against the live
  // remote tip on every retry) both read this same flag — see
  // apiFallbackMergeEntriesFor() below. Loss here was already explicitly
  // accepted at a coarser grain (see scripts/lib/push-content-survival.js's
  // CONTENT_SURVIVAL_EXEMPT_LEDGERS and owner-alert-router.js's module
  // header) — a real per-key merge is a strict improvement on that existing
  // baseline, not a new correctness bar.
  //
  // data/audit/triage/ remains NOT added: it is a DIRECTORY of per-item
  // files (also written by rebuild-reviews.yml), a different shape from the
  // generic {ours,remote}->{merged,stats} single-file contract this registry
  // and push-via-git-api.sh's blob-overlay both assume — needs its own
  // design, out of scope here.
  {
    file: 'audit/alert-ledger.json',
    surface: 'public-repo',
    status: 'active',
    merge: mergeAlertLedger,
    format: 'json',
    newline: true,
    apiFallbackMerge: true,
    // Excluded from the LOCAL flow's opt-in reconcile-merged-json.js pass
    // (and therefore from reconcile-coverage.js's ~20-workflow "did this
    // step opt into PUSH_RECONCILE_MERGED_JSON=1" gate) — same reasoning as
    // audit/feedback-request-ledger.json and audit/express-retry-queue.json
    // above: this merge fn's ONLY consumer is push-via-git-api.sh's
    // apiFallbackMerge path. The local flow's pre-existing behavior for this
    // file (last-writer-wins on conflict) is UNCHANGED by this entry — that
    // was already an explicitly accepted loss (push-content-survival.js's
    // CONTENT_SURVIVAL_EXEMPT_LEDGERS), not a new gap this task needs to
    // close on the slow path too.
    optInReconcile: false,
    verifiedBy: '2026-09-04 (BRO-2413): 12 independent writers via routeAlert() (owner-alert-router.js) — real per-conditionKey union merge (keeps the fresher lastSeen on collision) replaces the old whole-file "ours wins outright" gap. See scripts/lib/merge-alert-ledger.js for the full design note.',
  },
  {
    file: 'audit/alert-digest-queue.json',
    surface: 'public-repo',
    status: 'active',
    merge: mergeAlertDigestQueue,
    format: 'json',
    newline: true,
    apiFallbackMerge: true,
    optInReconcile: false, // see audit/alert-ledger.json's comment above
    verifiedBy: '2026-09-04 (BRO-2413): 8 independent writers via queueDigestLine() (owner-alert-router.js) — real per-conditionKey union merge (keeps the fresher queuedAt on collision). See scripts/lib/merge-alert-digest-queue.js.',
  },
  {
    file: 'audit/alert-router-attempts.jsonl',
    surface: 'public-repo',
    status: 'active',
    merge: mergeAlertRouterAttempts,
    format: 'jsonl',
    apiFallbackMerge: true,
    optInReconcile: false, // see audit/alert-ledger.json's comment above
    verifiedBy: '2026-09-04 (BRO-2413): 3 independent writers — append-only log, union deduped by (ts, conditionKey). See scripts/lib/merge-alert-router-attempts.js.',
  },
  {
    file: 'audit/guard-escalation-state.json',
    surface: 'public-repo',
    status: 'active',
    merge: mergeGuardEscalationState,
    format: 'json',
    newline: true,
    apiFallbackMerge: true,
    optInReconcile: false, // see audit/alert-ledger.json's comment above
    verifiedBy: '2026-09-11 (BRO-447): 3 independent writers, each owning its own top-level guard-id key (check-corpus-drift.js: corpus-drift-audit-crash, check-rebuild-staleness.js: stale-checkout-staleness, check-vercel-build-guard.js: vercel-build-guard-restore-failed), invoked from 3 workflows with 3 DIFFERENT concurrency groups (check-corpus-drift, rebuild-reviews, vercel-build-guard) — genuinely cross-workflow racy, not a single-group queue. Real per-key union merge (keeps the fresher lastBlockedAt/lastClearedAt on a same-key collision, not expected today but not structurally prevented). Was entirely unregistered before this — the whole check-corpus-drift.yml commit (also touching this path) was disqualified from the Git Data API fallback and left on the slow fetch+rebase+push loop, which was losing races 3x/24h. See scripts/lib/merge-guard-escalation-state.js. UPDATE 2026-09-16 (BRO-2423): 3 more independent writers, same one-key-per-guard shape, no registry change needed (the merge fn is generic over top-level keys) — check-scoring-queue-guard.js: scoring-queue-scan-failed, run-ensemble-scoring-guard.js: ensemble-scoring-pipeline-crashed (both llm-ensemble-score.yml, concurrency group scoring-reviews[-reason]), check-review-count-drift-guard.js: review-count-drift-strict-breach (check-review-count-drift.yml, concurrency group check-review-count-drift) — now 6 total.',
  },
  {
    file: 'audit/breaker-transitions.jsonl',
    surface: 'public-repo',
    status: 'active',
    merge: mergeBreakerTransitions,
    format: 'jsonl',
    apiFallbackMerge: true,
    optInReconcile: false, // see audit/alert-ledger.json's comment above
    verifiedBy: '2026-09-08 (BRO-3022): 2 writers (scripts/check-sd-breaker.js, scripts/check-bd-breaker.js) via scripts/lib/breaker-transitions.js appendTransition() — append-only log, union deduped by (ts, conditionKey), no retention prune so no base-aware delete branch is needed. Registered specifically so that adding this path to commercial-rss-poll.yml\'s "Commit breaker state" step does NOT trip push-with-retry.sh\'s "unaudited data/audit/ path" disqualifier and silently strip the Git Data API fallback from the very commit BRO-2960 carved out and BRO-335 tuned for push contention. NOT apiFallbackSafe: that claims "no reconciliation needed" and is ours-wins-outright, which would drop the other side\'s appended rows (the residual risk documented on audit/autonomous-recheck-ledger.jsonl above) — for an append-only ledger a real per-row union is required. See scripts/lib/merge-breaker-transitions.js.',
  },
  {
    file: 'audit/ob-venue-candidates.json',
    surface: 'public-repo',
    status: 'active',
    merge: mergeObVenueCandidates,
    format: 'json',
    newline: false,
    // BRO-158 ("the #788 class"): 4 independent producers (discover-new-
    // shows.js's OB venue fan-out, add-requested-show.js, extract-
    // aggregator-candidates.js, promote-ob-venue-candidates.js) each run in
    // their own GitHub Actions checkout — no shared filesystem, so
    // venue-listing-discover.js's withFileLock (same-host protection only)
    // can't cover this. A real conflict here used to fall to the generic
    // `data/collection-state/*|data/audit/*)` "keep local" case in
    // push-with-retry.sh — a whole-file overwrite that silently dropped
    // every candidate the OTHER run staged or pruned this same push cycle.
    // Reconciled via BOTH the resolve_conflicts() case-arm (like audit/
    // feedback-request-ledger.json and audit/express-retry-queue.json above)
    // AND the opt-in post-rebase reconcile pass (default — optInReconcile
    // NOT set to false, unlike those two): update-show-status.yml's "Commit
    // and push changes" step (the ONLY step that runs discover-new-shows.js)
    // already sets PUSH_RECONCILE_MERGED_JSON=1 and stages this exact file
    // (verified — .github/workflows/update-show-status.yml:610,634,640), and
    // push-with-retry.sh's primary path is `git rebase -X theirs`, which
    // resolves two producers appending different candidates near the array
    // tail as a non-conflicting hunk — the resolve_conflicts() case-arm never
    // even runs on that path (same gap awards.json's entry above documents
    // and opts into reconcile_merged_json for). Second-opinion review finding
    // (2026-08-26): case-arm-only would have left this, the LIKELY-common
    // race shape for this file, uncovered.
  },
  // BRO-2296: `apiFallbackMerge: true` added to these two — audit-census-
  // recall.yml's single commit step also stages census-recall-status.json/
  // serp-census-recall.json (now apiFallbackSafe, see those entries above),
  // and push-with-retry.sh's Git Data API fallback disqualifier trips on the
  // WHOLE commit if ANY staged managed file lacks apiFallbackMerge coverage
  // — these two, already 'active' with a real union-merge fn used by the
  // local PUSH_RECONCILE_MERGED_JSON path, were the disqualifiers. Same
  // pattern as commercial-pending-review.json/audit/feedback-request-
  // ledger.json above: the SAME merge fn opts into both paths, no new
  // reconciliation logic needed. scraper-spend-ledger.jsonl stays genuinely
  // multi-writer (5+ workflows per its own header) — apiFallbackMerge does
  // real per-entry union reconciliation, unlike apiFallbackSafe's fail-closed
  // whole-file overwrite, so multi-writer is not a disqualifier here.
  { file: 'audit/scraper-spend-ledger.jsonl', surface: 'public-repo', status: 'active', merge: mergeScraperSpendLedger, format: 'jsonl', apiFallbackMerge: true },
  { file: 'audit/owner-email-log.jsonl', surface: 'public-repo', status: 'active', merge: mergeOwnerEmailLog, format: 'jsonl' },
  { file: 'audit/census-recall-trend.jsonl', surface: 'public-repo', status: 'active', merge: mergeCensusRecallTrend, format: 'jsonl', apiFallbackMerge: true },
  // BRO-3071 (2026-09-14): apiFallbackMerge added — already 'active' with a
  // real per-date union merge (mergeCoverageAdversarialProbeTrend, task #903)
  // used today by the LOCAL PUSH_RECONCILE_MERGED_JSON path (coverage-
  // adversarial-probe.yml sets it), but missing this flag disqualified
  // push-with-retry.sh's Git Data API fallback for the WHOLE "Commit probe
  // report + trend ledger" commit (same shape as commercial-pending-
  // review.json/BRO-2795 and census-recall-trend.jsonl/BRO-2296 above),
  // defeating the two newly-registered apiFallbackSafe files it's bundled
  // with (audit/coverage-adversarial-probe.json, audit/coverage-adversarial-
  // probe-status.json). Same merge fn opts into both paths, no new
  // reconciliation logic needed.
  { file: 'audit/coverage-adversarial-probe-trend.jsonl', surface: 'public-repo', status: 'active', merge: mergeCoverageAdversarialProbeTrend, format: 'jsonl', apiFallbackMerge: true },
  {
    file: 'awards.json',
    surface: 'public-repo',
    status: 'active',
    merge: mergeAwardsJson,
    format: 'json',
    newline: true,
    // awards.json is DUAL-TRACKED (.github/workflows/CLAUDE.md "Public Show
    // JSON Safety" section): unlike every other CORE_FILES entry it's ALSO
    // committed straight to this repo (update-tony-awards.yml /
    // update-precursor-awards.yml both `git add data/awards.json` + push-
    // with-retry.sh, in addition to calling push-core-data). Same real risk
    // as the private-core-data entry below (two independently-scheduled
    // seasonal writers), same merge fn — registered on both surfaces because
    // it genuinely pushes through both. UNLIKE audit/feedback-request-
    // ledger.json above, this DOES participate in reconcile-merged-json.js's
    // opt-in pass (both writer workflows set PUSH_RECONCILE_MERGED_JSON=1) —
    // a case-arm-only registration left the common `-X ours` clean-rebase
    // path (which never raises a conflict) unprotected (ship-check/Codex
    // adversarial finding, BRO-76): the case arm in resolve_conflicts() only
    // fires when git actually reports a conflict, and a nearby non-
    // overlapping hunk can rebase clean while still discarding one side's
    // edit.
  },
  {
    file: 'outlet-registry.json',
    surface: 'public-repo',
    status: 'single-writer',
    note: 'BRO-1084: moved from private-core-data to public-repo — the private copy was routinely stale because the only real writer is a human running scripts/audit-outlet-registry.js --update/--auto locally (CI only ever runs --json/--update-baseline/--strict, never the write branch), and every new outlet addition depended on a manual gh api PUT to the private repo before the next checkout-core-data run silently overwrote it. No CI workflow writes this file, so there is no concurrency group to declare.',
  },

  // ── private-core-data surface (push-core-data/action.yml, CORE_FILES) ────
  {
    file: 'shows.json',
    surface: 'private-core-data',
    status: 'special',
    note: 'per-field reconciliation (venue/dates/closingDate/tourLegs/etc.), not a whole-entry union — see scripts/lib/reconcile-shows-fields.js, wired inline in push-core-data/action.yml',
  },
  {
    file: 'audience-buzz.json',
    surface: 'private-core-data',
    status: 'special',
    note: 'per-source-entry merge + combinedScore recalculation, wired inline in push-core-data/action.yml (not a generic {ours,remote}->{merged,stats} shape)',
  },
  {
    file: 'commercial.json',
    surface: 'private-core-data',
    status: 'special',
    note: 'already reconciled via mergeCommercialJson, wired inline in push-core-data/action.yml — same merge fn as the public-repo entry above, kept inline there to avoid touching proven incident-scarred logic (BRO-76 scope decision)',
  },
  {
    file: 'commercial-pending-review.json',
    surface: 'private-core-data',
    status: 'special',
    note: 'already reconciled via mergePendingReview, wired inline in push-core-data/action.yml (BRO-76 scope decision, see commercial.json note)',
  },
  {
    file: 'diary-shows.json',
    surface: 'private-core-data',
    status: 'special',
    note: 'already reconciled via mergeDiaryShows, wired inline in push-core-data/action.yml (BRO-76 scope decision, see commercial.json note)',
  },
  { file: 'awards.json', surface: 'private-core-data', status: 'active', merge: mergeAwardsJson, format: 'json', newline: true },
  { file: 'opening-night-sent.json', surface: 'private-core-data', status: 'active', merge: mergeOpeningNightSent, format: 'json', newline: true },
  { file: 'critic-registry.json', surface: 'private-core-data', status: 'active', merge: mergeCriticRegistry, format: 'json', newline: true },
  { file: 'grosses-history.json', surface: 'private-core-data', status: 'active', merge: mergeGrossesHistory, format: 'json', newline: true },
  {
    file: 'reviews.json',
    surface: 'private-core-data',
    status: 'active',
    merge: mergeReviewsJson,
    format: 'json',
    newline: true,
    // BRO-76 follow-up (card #1834): the hottest multi-writer file (20+
    // independently-scheduled writers) AND the central scoring-pipeline file
    // (CLAUDE.md §3/§12), so this was deliberately deferred out of BRO-76's
    // first pass rather than reusing the generic keyed-union pattern on a
    // deadline. scripts/lib/merge-reviews-json.js's module comment has the
    // full design (identity = outlet+criticKey with a canonicalized-URL
    // fallback, reusing manual-entry-merge.js/review-guards.js's own
    // normalizers; conflicts resolve manualEntry > newer whole-snapshot
    // _meta.lastUpdated > contentTier > ours; disjoint keys union, with a
    // documented accepted limitation) — see it before
    // touching this entry. Verified with scripts/scoring-delta.js and
    // scripts/test-temporal-override-regression.js before flipping to
    // 'active'.
  },
  { file: 'grosses.json', surface: 'private-core-data', status: 'single-writer', note: 'both writers (scrape-alltime-grosses, weekly-grosses) share concurrency group data-grosses-writers — mutually exclusive, no real race' },
  { file: 'critic-consensus.json', surface: 'private-core-data', status: 'single-writer', note: 'only update-critic-consensus.yml writes it' },
  { file: 'audience-reviews-lbo.json', surface: 'private-core-data', status: 'single-writer', note: 'single writer, update-lbo.yml' },
  { file: 'followers.json', surface: 'private-core-data', status: 'single-writer', note: 'single writer, send-follow-notifications.yml, own concurrency group' },
  { file: 'subscribers.json', surface: 'private-core-data', status: 'single-writer', note: 'single writer, send-follow-notifications.yml, own concurrency group' },
  { file: 'subscribers-westend.json', surface: 'private-core-data', status: 'single-writer', note: 'single writer, send-follow-notifications.yml, own concurrency group' },
];

/**
 * Look up a registry entry by file path or basename, scoped to a surface.
 * @param {string} file repo-relative path (public-repo) or CORE_FILES
 *   basename (private-core-data) — matched by suffix so either convention
 *   ('data/commercial.json' or 'commercial.json') finds the same entry.
 * @param {string} [surface] 'public-repo' | 'private-core-data'; omit to
 *   search both (returns the first match — only safe when the caller doesn't
 *   care which surface, e.g. the lint gate's "is this file known at all?"
 *   check).
 */
function findEntry(file, surface) {
  const candidates = surface ? CORE_DATA_MERGE_REGISTRY.filter((e) => e.surface === surface) : CORE_DATA_MERGE_REGISTRY;
  return candidates.find((e) => file === e.file || file.endsWith('/' + e.file)) || null;
}

/** Active (generic-merge-eligible) entries for one surface, restricted to the
 * ones actually driven by that surface's opt-in reconcile pass (excludes
 * entries only reachable via a direct case-arm dispatch — see
 * `optInReconcile: false` above). */
function activeEntriesFor(surface) {
  return CORE_DATA_MERGE_REGISTRY.filter((e) => e.surface === surface && e.status === 'active' && e.optInReconcile !== false);
}

/** Entries explicitly marked `apiFallbackSafe: true` for one surface — see
 * the header comment on the first such entry above for what this claim
 * means and why it is a SEPARATE, narrower field from `status`. Returns
 * DOCUMENTATION CLAIMS (hand-verified at the `verifiedBy` note's time), not
 * a live safety guarantee — callers that grant a real bypass on the
 * strength of this list (push-with-retry.sh, via reconcile-merged-json.js's
 * API_FALLBACK_SAFE export) are trusting the verification process this
 * registry entry documents, not re-deriving it. */
function apiFallbackSafeEntriesFor(surface) {
  return CORE_DATA_MERGE_REGISTRY.filter((e) => e.surface === surface && e.apiFallbackSafe === true);
}

/** Entries explicitly marked `apiFallbackMerge: true` for one surface — a
 * narrower, DISTINCT claim from `apiFallbackSafe`: "this file is genuinely
 * multi-writer AND carries a real merge function safe to run inside
 * push-via-git-api.sh's per-retry loop", vs apiFallbackSafe's "no merge
 * needed at all" (BRO-2413). Every entry here also has `status: 'active'`
 * (so activeEntriesFor()/MANAGED still reconciles it on the slow local
 * flow as a backstop) — the two lists overlap by design, they are not
 * alternatives. */
function apiFallbackMergeEntriesFor(surface) {
  return CORE_DATA_MERGE_REGISTRY.filter((e) => e.surface === surface && e.apiFallbackMerge === true);
}

module.exports = { CORE_DATA_MERGE_REGISTRY, findEntry, activeEntriesFor, apiFallbackSafeEntriesFor, apiFallbackMergeEntriesFor };
