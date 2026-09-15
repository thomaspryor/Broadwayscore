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
 */
'use strict';

const DEFAULT_AGE_BOUND_DAYS = 90;
const DEFAULT_GRACE_DAYS = 3;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_ATTEMPT_DAYS = 30;
const DEFAULT_BATCH_SIZE = 10;

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
    if (!s || s.status !== 'open') continue;
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

module.exports = {
  DEFAULT_AGE_BOUND_DAYS,
  DEFAULT_GRACE_DAYS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_ATTEMPT_DAYS,
  DEFAULT_BATCH_SIZE,
  hasGivenUp,
  selectCatchupCandidates,
};
