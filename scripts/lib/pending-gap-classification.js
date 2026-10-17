/**
 * Classify pending-score gap records into "stuck" (age above threshold) and
 * "fresh" (age at or below threshold, or unknown age).
 *
 * Extracted from scripts/validate-data.js:validateUnscoredReviewTexts so the
 * thresholding can be unit-tested independently. The classification fires two
 * distinct warnings — one advisory ("pipeline will pick these up next run"),
 * one louder ("pipeline has NOT picked these up") — so regressions on the
 * split silently break the opening-night gap-visibility signal.
 *
 * A gap record looks like:
 *   { showDir, file, outlet, critic, tier, words, pending, ageDays }
 * where `ageDays` may be null when textFetchedAt is missing.
 *
 * Invariants:
 *   - `thresholdDays` must be a finite positive number. Defaults to 7.
 *   - Records whose `ageDays` is null/undefined are treated as FRESH. Reason:
 *     a missing timestamp is most often a freshly created placeholder, not a
 *     silently stuck file. Flagging them as stuck would cause false alarms.
 *   - `ageDays > thresholdDays` is strict-greater-than to match the original
 *     inline split in validate-data.js (7 days exact is still "fresh").
 */

const DEFAULT_STUCK_PENDING_DAYS = 7;

function classifyPendingGapsByAge(gaps, thresholdDays = DEFAULT_STUCK_PENDING_DAYS) {
  if (!Array.isArray(gaps)) throw new TypeError('gaps must be an array');
  if (!Number.isFinite(thresholdDays) || thresholdDays <= 0) {
    throw new RangeError(`thresholdDays must be a positive number, got ${thresholdDays}`);
  }

  const stuck = [];
  const fresh = [];
  for (const g of gaps) {
    if (g && g.ageDays != null && Number.isFinite(g.ageDays) && g.ageDays > thresholdDays) {
      stuck.push(g);
    } else {
      fresh.push(g);
    }
  }
  return { stuck, fresh };
}

module.exports = {
  classifyPendingGapsByAge,
  DEFAULT_STUCK_PENDING_DAYS,
};
