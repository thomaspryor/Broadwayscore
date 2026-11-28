/**
 * closing-date-evidence.js (BRO-7251)
 *
 * Pure decision helpers for "is this date evidence strong enough to WRITE a
 * closingDate". Ticket calendars (broadway.com schedule, TodayTix endDate)
 * list performances only as far as tickets are on sale, so for an open-ended
 * run their last date is a booking horizon, not an announced closing. Neither
 * signal may write a closingDate on its own.
 */

const MAX_AUTO_EXTENSION_DAYS = 180;
const AMBIGUOUS_DELTA_THRESHOLD_DAYS = 30;
// A TodayTix endDate this far out, shared by this many shows, is the feed's
// on-sale window, not per-show closings.
const HORIZON_MIN_DAYS_OUT = 90;
const HORIZON_MIN_SHARED = 3;

function dayDiff(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 86400000);
}

/**
 * Classify broadway.com schedule evidence against the stored closingDate.
 * Never returns a write action: an extension on schedule evidence alone is
 * routed to review (the press-cluster pass may then corroborate it).
 */
function classifyScheduleEvidence(stored, latest) {
  if (!latest) return { action: 'NO_EVIDENCE', write: false };
  if (!stored) return { action: 'NEW_CLOSING_NEEDS_REVIEW', write: false };
  const delta = dayDiff(latest, stored);
  if (delta > 0 && delta > MAX_AUTO_EXTENSION_DAYS) return { action: 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW', write: false, delta };
  if (delta > 0) return { action: 'EXTENSION_SCHEDULE_ONLY_NEEDS_REVIEW', write: false, delta };
  if (delta < 0 && Math.abs(delta) > AMBIGUOUS_DELTA_THRESHOLD_DAYS) return { action: 'NEEDS_HUMAN_REVIEW', write: false, delta };
  return { action: 'MATCH', write: false, delta };
}

/**
 * True when a TodayTix endDate looks like the feed's booking horizon:
 * far enough out and shared by several shows in the same feed.
 */
function isTodayTixBookingHorizon(endDate, feedEndDates, todayStr) {
  if (!endDate) return false;
  if (dayDiff(endDate, todayStr) < HORIZON_MIN_DAYS_OUT) return false;
  const shared = (feedEndDates || []).filter(d => d === endDate).length;
  return shared >= HORIZON_MIN_SHARED;
}

module.exports = {
  classifyScheduleEvidence,
  isTodayTixBookingHorizon,
  MAX_AUTO_EXTENSION_DAYS,
  AMBIGUOUS_DELTA_THRESHOLD_DAYS,
  HORIZON_MIN_DAYS_OUT,
  HORIZON_MIN_SHARED,
};
