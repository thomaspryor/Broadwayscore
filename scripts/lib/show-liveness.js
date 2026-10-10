'use strict';

/**
 * show-liveness.js — the ONE "is this show live, or only recently closed?"
 * predicate (2026 data audit, S7-T7).
 *
 * Before this module four fixers each carried their own ad-hoc status filter,
 * and every one of them excluded closed rows forever:
 *
 *   scripts/replay-pending-bylines.js       ['open','previews'].includes(status)
 *   scripts/lib/zero-review-catchup.js      s.status === 'open'
 *   scripts/lib/opening-night-completeness  STALE_UPCOMING_STATUSES = {'open'}
 *   scripts/lib/ob-date-fix-eligibility.js  ELIGIBLE_STATUSES.has(status)
 *
 * The audit found 107 shows with reviews stranded in the no-byline _pending
 * strand (287 files), 86 of them closed — the only drain ran `--all-open`
 * every 6 hours, so a show that closed the week its reviews landed never
 * drained (Othello Off-Broadway: 34 waiting vs 2 live, no score).
 *
 * The predicate has one rule and every caller passes the options that
 * reproduce its historical filter BY CONSTRUCTION (each caller keeps its own
 * frozen options object next to the call, and
 * tests/unit/show-liveness.test.mjs asserts each one equals the old inline
 * filter over the whole status matrix):
 *
 *   - a row whose status is in `liveStatuses` is live (default
 *     open/previews/upcoming);
 *   - a `closed` row counts ONLY when `allowClosed` is set AND its
 *     closingDate is no more than `withinDays` days before `today`
 *     (`withinDays: Infinity` admits every closed row, closingDate or not);
 *   - every other status (announced, cancelled, postponed, transferred, …)
 *     is not live unless the caller lists it in `liveStatuses`.
 *
 * Pure: no fs, no clock unless `today` is omitted.
 */

const LIVE_STATUSES = Object.freeze(['open', 'previews', 'upcoming']);
const DAY_MS = 86_400_000;

/**
 * UTC day number (days since the epoch) for an ISO date/datetime string, a
 * Date, or an epoch-ms number. A plain 'YYYY-MM-DD' is read as that UTC day
 * (no local-timezone drift); null when unparseable.
 */
function toUtcDayNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  let ms;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/);
    ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value).getTime();
  } else {
    return null;
  }
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
}

/**
 * Whole days between the show's closingDate and `today` (positive = closed in
 * the past, negative = closingDate still ahead). null when either side is
 * missing or unparseable.
 */
function daysSinceClosing(show, today = new Date()) {
  const closed = toUtcDayNumber(show && show.closingDate);
  const now = toUtcDayNumber(today);
  if (closed === null || now === null) return null;
  return now - closed;
}

/**
 * @param {object} show               shows.json row ({ status, closingDate, … })
 * @param {object} [options]
 * @param {number} [options.withinDays=0]      closed rows count when they closed
 *                                             at most this many days before `today`
 *                                             (Infinity = any closed row)
 * @param {boolean} [options.allowClosed=false] admit closed rows at all
 * @param {Date|string|number} [options.today]  clock injection (default: now)
 * @param {Iterable<string>} [options.liveStatuses=LIVE_STATUSES]
 *                                             statuses that are live outright
 * @returns {boolean}
 */
function isRecentlyLive(show, options = {}) {
  if (!show || typeof show !== 'object') return false;
  const {
    withinDays = 0,
    allowClosed = false,
    today = new Date(),
    liveStatuses = LIVE_STATUSES,
  } = options || {};

  const live = liveStatuses instanceof Set ? liveStatuses : new Set(liveStatuses);
  if (live.has(show.status)) return true;
  if (show.status !== 'closed' || !allowClosed) return false;
  if (withinDays === Infinity) return true;

  const days = Number(withinDays);
  if (!Number.isFinite(days) || days < 0) return false;
  const since = daysSinceClosing(show, today);
  // A closed row whose closingDate is still ahead (since < 0) is at most
  // 0 days closed — inconsistent data, but recently live by any reading.
  return since !== null && since <= days;
}

module.exports = {
  LIVE_STATUSES,
  isRecentlyLive,
  daysSinceClosing,
  toUtcDayNumber,
};
