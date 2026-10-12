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
 * One scoped exception to "open shows only" (BRO-4290): rows the OWE
 * promoter built from audit review evidence (promote-owe-venue-candidates.js,
 * discoverySource 'audit-review-evidence', evidenceUrls = the review that
 * proved the show exists) are mostly closed runs, often with no openingDate,
 * and nothing else ever gathers their reviews. They qualify while their
 * discoveredAt is inside the age bound, under the same exempt/givenUp rules,
 * and at most DEFAULT_EVIDENCE_PER_BATCH ride each batch after the open rows
 * (a closed-show gather is slow and spends SERP credits).
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
const DEFAULT_EVIDENCE_PER_BATCH = 2;
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
 * @param {object} opts {now, ageBoundDays, graceDays, maxAttempts, maxAttemptDays, batchSize, evidencePerBatch}
 * @returns {{batch: string[], evidence: string[], tooOld: string[], exempt: string[], givenUp: string[]}}
 *   evidence = the evidence-promoted ids inside batch (for logging).
 */
function selectCatchupCandidates(shows, reviews, attempts, opts = {}) {
  const now = opts.now ?? Date.now();
  const ageBoundDays = opts.ageBoundDays ?? DEFAULT_AGE_BOUND_DAYS;
  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const evidencePerBatch = opts.evidencePerBatch ?? DEFAULT_EVIDENCE_PER_BATCH;
  const attemptMap = attempts || {};

  const reviewCounts = {};
  for (const r of (reviews || [])) {
    if (r && r.showId) reviewCounts[r.showId] = (reviewCounts[r.showId] || 0) + 1;
  }

  const eligible = [];
  const eligibleEvidence = [];
  const tooOld = [];
  const exempt = [];
  const givenUp = [];

  for (const s of (shows || [])) {
    if (!s) continue;
    // Evidence-promoted closed rows: checked before the open-only and
    // openingDate gates, which would drop them. Aged from discoveredAt.
    if (s.status === 'closed' && isEvidencePromoted(s) && !reviewCounts[s.id]) {
      const sinceDiscovery = daysSince(s.discoveredAt, now);
      if (sinceDiscovery == null) continue;
      if (s.noReviewsExpected) { exempt.push(s.id); continue; }
      // Past the window: dropped silently. tooOld feeds a 'status/data
      // problem' warning, which a closed run is not, and closed rows never
      // leave that list, so it would only grow.
      if (sinceDiscovery > ageBoundDays) continue;
      if (hasGivenUp(attemptMap[s.id], now, opts)) { givenUp.push(s.id); continue; }
      eligibleEvidence.push(s.id);
      continue;
    }
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

  const batch = eligible.slice(0, batchSize);
  const evidence = eligibleEvidence.slice(0, Math.max(0, Math.min(evidencePerBatch, batchSize - batch.length)));
  return {
    batch: [...batch, ...evidence],
    evidence,
    tooOld,
    exempt,
    givenUp,
  };
}

module.exports = {
  DEFAULT_AGE_BOUND_DAYS,
  DEFAULT_GRACE_DAYS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_ATTEMPT_DAYS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_EVIDENCE_PER_BATCH,
  AUDIT_EVIDENCE_SOURCE,
  CATCHUP_LIVENESS,
  hasGivenUp,
  selectCatchupCandidates,
};
