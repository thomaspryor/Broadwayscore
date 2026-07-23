'use strict';

/**
 * S5-T1 — late-add defect detection.
 *
 * A "late add" is a show whose earliest scored critic review predates our
 * own catalog clock (previewsStartDate, falling back to openingDate) by more
 * than a normal pre-opening preview window. That's the signature of adding a
 * show to the catalog well after critics already covered it — usually a
 * transfer/return where we catalog the LATER run's dates as canonical but
 * miss that reviews exist for an earlier run (the dad-dont-read-this class:
 * Off-Broadway transfer catalogued off its Greenwich House dates while NYT/
 * Vulture reviews from the original St. Luke's run predate those by ~5-6
 * weeks). shows.json has no reliable createdAt field and this repo's core-
 * data checkout is shallow (no git history to derive one), so this measures
 * against the THEATRICAL clock instead — a real signal that needs no git
 * history and is directly actionable (it tells you to check for a priorRuns
 * entry or a wrong openingDate).
 *
 * GRACE_DAYS=30 matches the existing pre-opening carve-out convention used
 * elsewhere (scripts/lib/manual-review-fields.js detectIngestCollision) so
 * this doesn't introduce a second, disagreeing threshold for "how early is
 * too early for a review."
 */

const { isPublishDateSuspect } = require('./t1-sla.js');

const GRACE_DAYS = 30;
const DAY_MS = 86400000;

/**
 * @param {Array<object>} reviewsForShow scored reviews for one show:
 *   { assignedScore, publishDate, firstSeenAt, publishDateSource?, outletId }
 * @param {string|null} catalogClockIso previewsStartDate || openingDate
 * @returns {{ isLateAdd:boolean, reason?:string, gapDays?:number,
 *             earliestReviewDate?:string, earliestOutletId?:string, catalogClock?:string }}
 */
function detectLateAdd(reviewsForShow, catalogClockIso) {
  if (!catalogClockIso) return { isLateAdd: false, reason: 'no-catalog-clock' };
  const catalogMs = Date.parse(catalogClockIso);
  if (!Number.isFinite(catalogMs)) return { isLateAdd: false, reason: 'no-catalog-clock' };

  let earliest = null;
  for (const r of reviewsForShow || []) {
    if (!r || r.assignedScore == null) continue;
    if (isPublishDateSuspect(r)) continue; // no date, or a fetch-date stamp we can't trust
    const ms = Date.parse(r.publishDate);
    if (!Number.isFinite(ms)) continue;
    if (earliest == null || ms < earliest.ms) {
      earliest = { ms, outletId: r.outletId, publishDate: r.publishDate };
    }
  }
  if (!earliest) return { isLateAdd: false, reason: 'no-measurable-reviews' };

  const gapDays = Math.round((catalogMs - earliest.ms) / DAY_MS);
  return {
    isLateAdd: gapDays > GRACE_DAYS,
    gapDays,
    earliestReviewDate: earliest.publishDate,
    earliestOutletId: earliest.outletId,
    catalogClock: catalogClockIso,
  };
}

module.exports = { detectLateAdd, GRACE_DAYS };
