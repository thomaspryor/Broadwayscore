'use strict';
/**
 * BRO-6725: UK regional opening dates seeded from the first Guardian/census review
 * ('guardian-review' / 'census-review') are an upper bound on the press night, never
 * the press night itself. When another outlet reviewed earlier (The Stage, WhatsOnStage
 * and others publish the morning after press night), the stored date sits after a
 * review. reconcileOpeningDate() moves it to the earliest full-date review.
 *
 * BRO-6697: theatreinchicago rows seeded from the first review TIC listed
 * ('tic-first-review', scripts/lib/tic-stage.js) have the same shape: other outlets'
 * earlier reviews arrive after staging and the date stayed late (12 of 17 rows in the
 * "opening date vs review dates" health row, 2026-11-01).
 *
 * Pure: takes the show row and its review publish dates, returns a decision.
 * A gap wider than MAX_GAP_DAYS is not trusted (a stray review of another run or a
 * mis-dated page) and is reported for a human instead of applied.
 */
const SEEDED_SOURCES = new Set(['guardian-review', 'census-review', 'first-review-date', 'tic-first-review']);
const MAX_GAP_DAYS = 14;
const FIRST_REVIEW_SOURCE = 'first-review-date';
const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d));
const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

function earliestReviewDate(publishDates) {
  const days = (publishDates || []).filter(isDay).sort();
  return days[0] || null;
}

/**
 * `minReviews` (BRO-6697): the new date must have at least this many reviews on or
 * before it, so one stray (a preview-week blog post, a mis-dated page) cannot set it.
 * theatreinchicago rows pass 2; the UK path keeps 1.
 * @returns {{action:'none'|'move'|'manual', openingDate?:string, openingDateSource?:string, gapDays?:number, reason?:string}}
 */
function reconcileOpeningDate(show, publishDates, { minReviews = 1 } = {}) {
  const days = (publishDates || []).filter(isDay).sort();
  const first = days[Math.max(0, minReviews - 1)] || null;
  if (!first || !isDay(show && show.openingDate)) return { action: 'none' };
  const gap = daysBetween(show.openingDate, first);
  if (gap <= 0) return { action: 'none' };
  if (!SEEDED_SOURCES.has(show.openingDateSource)) {
    return { action: 'manual', gapDays: gap, reason: `opening date source '${show.openingDateSource}' is not review-seeded` };
  }
  if (gap > MAX_GAP_DAYS) return { action: 'manual', gapDays: gap, reason: `earliest review is ${gap} days before the stored opening date` };
  // BRO-6697: opening before first preview fails validate-data; that row needs a person.
  if (isDay(show.previewsStartDate) && first < show.previewsStartDate) {
    return { action: 'manual', gapDays: gap, reason: `earliest review ${first} is before previewsStartDate ${show.previewsStartDate}` };
  }
  return { action: 'move', openingDate: first, openingDateSource: FIRST_REVIEW_SOURCE, gapDays: gap };
}

module.exports = { reconcileOpeningDate, earliestReviewDate, SEEDED_SOURCES, MAX_GAP_DAYS, FIRST_REVIEW_SOURCE };
