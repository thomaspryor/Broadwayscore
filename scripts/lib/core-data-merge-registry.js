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
    // it genuinely pushes through both. Reconciled via push-with-retry.sh's
    // resolve_conflicts() case arm (unconditional on an actual conflict),
    // NOT reconcile-merged-json.js's opt-in pass — same reasoning as
    // audit/feedback-request-ledger.json above.
    optInReconcile: false,
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
    status: 'deferred',
    deferredReason:
      'genuinely the hottest multi-writer file (20+ independently-scheduled writers) but also the central scoring-pipeline file (CLAUDE.md §3/§12) — a wrong array-union merge risks silent scoring corruption across the whole site, not just one file. Needs its own dedicated, carefully-tested card rather than reusing this session\'s generic keyed-union pattern on the deadline this card was worked under.',
    followUp: 'BRO-76 follow-up card filed for reviews.json-specific reconciliation',
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

module.exports = { CORE_DATA_MERGE_REGISTRY, findEntry, activeEntriesFor };
