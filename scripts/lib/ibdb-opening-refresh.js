'use strict';
/**
 * BRO-8188: keep an IBDB-sourced opening date in step with IBDB when the opening moves.
 *
 * It's a Wonderful Life: A Live Radio Play (2026) took openingDate 2026-11-18 from IBDB. The press night was then
 * moved to 2026-11-23 and IBDB updated, but enrich-ibdb-dates.js only ever filled MISSING dates (and its weekly run
 * filtered out shows whose dates were all set), so the stored date stayed 11-18. Every press-night path keys off
 * openingDate: the lane, poller and watchdog ran on the 18th, stood down, and the real night's reviews arrived
 * only by hand.
 *
 * Which stored dates IBDB may replace: an IBDB date (Broadway; IBDB is the Broadway authority) or any source the
 * shared rule calls unconfirmed (isUnconfirmedDateSource: fallbacks, listings, null). Playbill, playbill-manual,
 * review-derived press nights and human corrections outrank it and are left alone; a disagreement there stays a
 * reported discrepancy. Runs daily from update-show-status.yml, before statuses are set.
 *
 * Two pure pieces, used by enrich-ibdb-dates.js:
 *   selectNearOpeningShows  which Broadway shows a daily near-opening pass looks at
 *   decideOpeningRefresh    whether IBDB's opening date replaces the stored one
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NEAR_BEFORE_DAYS = 45;   // a press night up to 45 days away can still be moved
const NEAR_AFTER_DAYS = 14;    // a stored press night up to 14 days past may have been a postponed one
const MAX_SHIFT_DAYS = 180;    // a bigger jump is another production, not a moved opening
const { isUnconfirmedDateSource } = require('./date-source-confidence');
const ACTIVE_STATUSES = new Set(['announced', 'upcoming', 'previews', 'open']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayMs(iso) {
  if (typeof iso !== 'string' || !ISO_DAY.test(iso)) return NaN;
  return Date.parse(`${iso}T12:00:00Z`);
}

/**
 * Broadway shows whose stored press night is within [now - 14d, now + 45d], or that have no opening date but
 * previews within that window. These are the shows a moved opening would hurt, and few enough to check daily.
 */
function selectNearOpeningShows(shows, nowMs, { beforeDays = NEAR_BEFORE_DAYS, afterDays = NEAR_AFTER_DAYS } = {}) {
  if (!Array.isArray(shows)) return [];
  return shows.filter((s) => {
    if (!s || !ACTIVE_STATUSES.has(s.status || 'open')) return false;
    if ((s.category || 'broadway') !== 'broadway') return false;
    const anchor = dayMs(s.openingDate) || dayMs(s.previewsStartDate);
    if (!Number.isFinite(anchor)) return false;
    return anchor >= nowMs - afterDays * DAY_MS && anchor <= nowMs + beforeDays * DAY_MS;
  });
}

/**
 * @returns {{refresh: boolean, reason: string}}
 */
function decideOpeningRefresh(show, ibdbOpeningDate, nowMs, { afterDays = NEAR_AFTER_DAYS } = {}) {
  const no = (reason) => ({ refresh: false, reason });
  if (!show || !show.openingDate) return no('no stored opening date (the fill-missing path owns it)');
  const ibdbMs = dayMs(ibdbOpeningDate);
  const storedMs = dayMs(show.openingDate);
  if (!Number.isFinite(ibdbMs) || !Number.isFinite(storedMs)) return no('a date is not YYYY-MM-DD');
  if (ibdbOpeningDate === show.openingDate) return no('IBDB agrees');
  if (show.humanCorrectedOpeningDate) return no('a person corrected this date');
  const fromIbdb = show.openingDateSource === 'ibdb' && (show.category || 'broadway') === 'broadway';
  if (!fromIbdb && !isUnconfirmedDateSource(show)) return no(`openingDateSource ${show.openingDateSource} outranks IBDB`);
  if (Math.abs(ibdbMs - storedMs) > MAX_SHIFT_DAYS * DAY_MS) return no(`IBDB date ${ibdbOpeningDate} is over ${MAX_SHIFT_DAYS} days from ${show.openingDate}: another production`);
  const previewsMs = dayMs(show.previewsStartDate);
  if (Number.isFinite(previewsMs) && ibdbMs < previewsMs) return no(`IBDB date ${ibdbOpeningDate} is before previews ${show.previewsStartDate}`);
  if (nowMs > Math.max(ibdbMs, storedMs) + afterDays * DAY_MS) return no('both dates are more than 14 days past: history, not a moved opening');
  return { refresh: true, reason: `IBDB moved the opening ${show.openingDate} -> ${ibdbOpeningDate}` };
}

module.exports = { selectNearOpeningShows, decideOpeningRefresh, NEAR_BEFORE_DAYS, NEAR_AFTER_DAYS, MAX_SHIFT_DAYS };
