/**
 * Pure selection logic for update-show-status.yml's catchup-zero-review-shows
 * job (BRO-3389). Extracted from an inline `node -e` block that had no upper
 * age bound and no attempt memory — it re-dispatched the same handful of
 * long-open zero-review shows every day forever (four Off-Broadway shows sat
 * in the batch for 7-19 months, each dispatch burning a gather-reviews run
 * that timed out finding nothing, because the underlying reviews genuinely
 * don't exist to find).
 *
 * Three independent reasons a zero-review open show is excluded from the
 * dispatch batch, so callers can log/warn on each separately instead of the
 * show just silently never appearing:
 *   - exempt:  show.noReviewsExpected is set (e.g. a Spanish-language
 *              rotating-repertory production with no English-press coverage)
 *   - tooOld:  opened before the age bound — an old zero-review show is a
 *              status/data problem, not something re-dispatching will fix
 *   - givenUp: attempt memory shows this show has already been retried past
 *              the give-up threshold
 *
 * Closed rows the OWE promoter built from audit review evidence
 * (promote-owe-venue-candidates.js, discoverySource 'audit-review-evidence',
 * evidenceUrls = the review that proved the show exists) are NOT in this
 * batch: a full gather of a closed show is slow and its spend is uncapped.
 * selectEvidenceSeedCandidates() picks them for
 * scripts/seed-evidence-review-stubs.js instead, which fetches only the
 * evidence URL under a hard monthly cap (BRO-4290,
 * scripts/lib/evidence-catchup-spend.js).
 */
'use strict';

const { isRecentlyLive } = require('./show-liveness');

// Liveness for catch-up candidacy: status=open ONLY. This reproduces the
// job's historical inline filter (`s.status !== 'open' → skip`) by
// construction — previews have no reviews to catch up yet, and a closed
// zero-review show is a status/data problem, not a dispatch target
// (audit S7-T7; tests/unit/show-liveness.test.mjs pins the equivalence).
const CATCHUP_LIVENESS = Object.freeze({ liveStatuses: Object.freeze(['open']), allowClosed: false });

const DEFAULT_AGE_BOUND_DAYS = 90;
const DEFAULT_GRACE_DAYS = 3;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_ATTEMPT_DAYS = 30;
const DEFAULT_BATCH_SIZE = 10;
// Evidence seeder: at most 2 closed shows per job (board triage 2026-10-10),
// and never more than 5 even when asked (the CLAUDE.md §8 five-show E2E).
const DEFAULT_EVIDENCE_PER_BATCH = 2;
const MAX_EVIDENCE_PER_BATCH = 5;
// Same literal as AUDIT_EVIDENCE_SOURCE in scripts/promote-owe-venue-candidates.js.
const AUDIT_EVIDENCE_SOURCE = 'audit-review-evidence';

function isEvidencePromoted(s) {
  return s.discoverySource === AUDIT_EVIDENCE_SOURCE
    && Array.isArray(s.evidenceUrls) && s.evidenceUrls.length > 0;
}

function daysSince(iso, nowMs) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 86400000;
}

/**
 * Give-up decision for one attempt-memory entry: true once EITHER the
 * attempt count or the age of the first attempt crosses its threshold.
 * @param {{attempts?: number, firstAt?: string}} entry
 * @param {number} nowMs
 */
function hasGivenUp(entry, nowMs, opts = {}) {
  if (!entry) return false;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxAttemptDays = opts.maxAttemptDays ?? DEFAULT_MAX_ATTEMPT_DAYS;
  if ((entry.attempts || 0) >= maxAttempts) return true;
  const ageDays = daysSince(entry.firstAt, nowMs);
  return ageDays != null && ageDays >= maxAttemptDays;
}

/**
 * @param {object[]} shows shows.json entries
 * @param {object[]} reviews reviews.json entries
 * @param {object} attempts attempt-memory map {showId: {attempts, firstAt, lastAt}}
 * @param {object} opts {now, ageBoundDays, graceDays, maxAttempts, maxAttemptDays, batchSize}
 * @returns {{batch: string[], tooOld: string[], exempt: string[], givenUp: string[]}}
 */
function selectCatchupCandidates(shows, reviews, attempts, opts = {}) {
  const now = opts.now ?? Date.now();
  const ageBoundDays = opts.ageBoundDays ?? DEFAULT_AGE_BOUND_DAYS;
  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const attemptMap = attempts || {};

  const reviewCounts = {};
  for (const r of (reviews || [])) {
    if (r && r.showId) reviewCounts[r.showId] = (reviewCounts[r.showId] || 0) + 1;
  }

  const eligible = [];
  const tooOld = [];
  const exempt = [];
  const givenUp = [];

  for (const s of (shows || [])) {
    if (!s) continue;
    if (!isRecentlyLive(s, CATCHUP_LIVENESS)) continue;
    if (reviewCounts[s.id]) continue;
    if (!s.openingDate) continue;
    // Give initial pipeline discovery a grace window before treating a show
    // as a catch-up candidate at all (unchanged from the original job).
    const ageDays = daysSince(s.openingDate, now);
    if (ageDays == null || ageDays < graceDays) continue;

    if (s.noReviewsExpected) { exempt.push(s.id); continue; }
    if (ageDays > ageBoundDays) { tooOld.push(s.id); continue; }
    if (hasGivenUp(attemptMap[s.id], now, opts)) { givenUp.push(s.id); continue; }
    eligible.push(s.id);
  }

  return {
    batch: eligible.slice(0, batchSize),
    tooOld,
    exempt,
    givenUp,
  };
}

/**
 * Closed evidence-promoted rows that still have zero reviews and whose
 * evidence URL has never been fetched by the seeder (BRO-4290). Aged from
 * discoveredAt (these rows often have no openingDate); past the age bound
 * they are dropped silently, since a closed run is not a status/data problem.
 * @param {object[]} shows shows.json entries
 * @param {object[]} reviews reviews.json entries
 * @param {Set<string>} alreadyFetched show ids the seeder has fetched before
 * @param {object} opts {now, ageBoundDays, limit}
 * @returns {{batch: {id: string, url: string}[], exempt: string[], eligible: number}}
 */
function selectEvidenceSeedCandidates(shows, reviews, alreadyFetched, opts = {}) {
  const now = opts.now ?? Date.now();
  const ageBoundDays = opts.ageBoundDays ?? DEFAULT_AGE_BOUND_DAYS;
  const limit = Math.max(0, Math.min(opts.limit ?? DEFAULT_EVIDENCE_PER_BATCH, MAX_EVIDENCE_PER_BATCH));
  const fetched = alreadyFetched || new Set();
  const reviewed = new Set((reviews || []).filter((r) => r && r.showId).map((r) => r.showId));
  const eligible = [];
  const exempt = [];
  for (const s of (shows || [])) {
    if (!s || s.status !== 'closed' || !isEvidencePromoted(s) || reviewed.has(s.id)) continue;
    const sinceDiscovery = daysSince(s.discoveredAt, now);
    if (sinceDiscovery == null || sinceDiscovery > ageBoundDays) continue;
    if (s.noReviewsExpected) { exempt.push(s.id); continue; }
    if (fetched.has(s.id)) continue;
    eligible.push({ id: s.id, url: s.evidenceUrls[0] });
  }
  return { batch: eligible.slice(0, limit), exempt, eligible: eligible.length };
}

module.exports = {
  DEFAULT_AGE_BOUND_DAYS,
  DEFAULT_GRACE_DAYS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_ATTEMPT_DAYS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_EVIDENCE_PER_BATCH,
  MAX_EVIDENCE_PER_BATCH,
  AUDIT_EVIDENCE_SOURCE,
  CATCHUP_LIVENESS,
  hasGivenUp,
  selectCatchupCandidates,
  selectEvidenceSeedCandidates,
  isEvidencePromoted,
};
