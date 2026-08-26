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

const CORE_DATA_MERGE_REGISTRY = [
  // ── public-repo surface (push-with-retry.sh) ──────────────────────────────
  { file: 'commercial.json', surface: 'public-repo', status: 'active', merge: mergeCommercialJson, format: 'json', newline: true },
  { file: 'commercial-pending-review.json', surface: 'public-repo', status: 'active', merge: mergePendingReview, format: 'json', newline: true },
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
  { file: 'audit/bww-roundup-miss-ledger.jsonl', surface: 'public-repo', status: 'active', merge: mergeBwwRoundupLedger, format: 'jsonl' },
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
  // retry.sh's disqualifier both treat an empty/absent flag as fail-closed,
  // no other file touched (ship-check finding: this is NOT a zero-file
  // revert though — core-data-merge-registry.test.mjs's "sanity: exactly the
  // seeded apiFallbackSafe entry" and api-fallback-writer-drift.test.mjs's
  // live-repo regression test both hardcode "expect >=1 entry" and will fail
  // loudly until updated to match — deliberately, so removing the last entry
  // is a reviewed two-line PR, not a silent, unnoticed policy change).
  {
    file: 'audit/health-digest-snapshot.json',
    surface: 'public-repo',
    status: 'single-writer',
    apiFallbackSafe: true,
    concurrencyGroup: 'data-health-check',
    verifiedBy: '2026-08-22: grepped every .github/workflows/*.yml for the literal filename — only data-health-check.yml (its "Commit digest snapshot" step) writes it; that workflow declares concurrency: {group: data-health-check, cancel-in-progress: false}, so overlapping runs queue rather than race.',
    note: 'the file scripts/autonomous-email.js:HEALTH_DIGEST_PATH reads to build the owner\'s daily digest email — the file whose lost push caused this task\'s originating incident (run 32559247279)',
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
  // step ("Commit health check audit snapshots (apiFallbackSafe)",
  // immediately after "Commit digest snapshot") so they get the same Git
  // Data API fallback protection.
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
  // NOT added, deliberately: data/audit/triage/ (also written by
  // rebuild-reviews.yml), data/audit/alert-ledger.json (12 writers),
  // data/audit/alert-digest-queue.json (8 writers — the exact file the
  // comment above this block warns about), data/audit/alert-router-
  // attempts.jsonl (3 writers). These stay in the bulk "Commit health check
  // + triage data" step, unprotected — genuinely multi-writer, no apiFallbackSafe
  // path available for them.
  { file: 'audit/scraper-spend-ledger.jsonl', surface: 'public-repo', status: 'active', merge: mergeScraperSpendLedger, format: 'jsonl' },
  { file: 'audit/owner-email-log.jsonl', surface: 'public-repo', status: 'active', merge: mergeOwnerEmailLog, format: 'jsonl' },
  { file: 'audit/census-recall-trend.jsonl', surface: 'public-repo', status: 'active', merge: mergeCensusRecallTrend, format: 'jsonl' },
  { file: 'audit/coverage-adversarial-probe-trend.jsonl', surface: 'public-repo', status: 'active', merge: mergeCoverageAdversarialProbeTrend, format: 'jsonl' },
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
  { file: 'outlet-registry.json', surface: 'private-core-data', status: 'single-writer', note: 'CI never actually reaches the write branch of audit-outlet-registry.js (needs --auto/interactive confirm; CI only runs --json/--update-baseline/--strict)' },
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

module.exports = { CORE_DATA_MERGE_REGISTRY, findEntry, activeEntriesFor, apiFallbackSafeEntriesFor };
