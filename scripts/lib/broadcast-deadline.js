'use strict';

/**
 * Opening-night draft deadline (BRO-4417).
 *
 * Why this exists: a Resend draft used to be created only by the daily 12:30
 * UTC cron (which GitHub fires 4-7h late) or a manual send_to_all dispatch.
 * If that one run hit a gate (checklist / drift / orphan-unscored), nothing
 * retried until the next day, and the 2-day lookback could drop the show
 * entirely (School Girls, 2026-09-29: the owner had to ask).
 *
 * Past the deadline, opening-night-broadcast.yml creates the draft on ANY run
 * and turns the QA gates advisory for these shows: they are overridden, and the
 * owner gets a page listing what each gate flagged. It is still a draft only.
 * The owner reviews it in Resend and presses Send, and nothing here reaches
 * subscribers.
 *
 * Both deadlines are hours after UTC midnight of the day AFTER the opening
 * date. openingDate is a calendar date ("YYYY-MM-DD", every row in shows.json),
 * so anchoring on UTC is deterministic regardless of the runner's timezone.
 */

const { shouldRequeueShow } = require('./broadcast-state');
const { wasCoveredByWeeklyRoundup, sentOnSiblingRecord } = require('./missed-broadcasts');

// Overdue alert: midnight ET (04:00 UTC in EDT) after opening night. This was
// inline in the workflow's overdue step as `openingDate+'T04:00:00Z'` + 1 day.
const OVERDUE_ALERT_UTC_HOUR = 4;
// Forced draft: 10:00 EDT / 09:00 EST for Broadway. For West End it is 15:00
// BST / 14:00 GMT, after the London morning papers and aggregators land.
// It must stay after the overdue alert, so the owner is paged before a gate is
// overridden, and early enough that one GitHub cron delay doesn't cost a day.
const DRAFT_DEADLINE_UTC_HOUR = 14;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayAfterOpeningAt(openingDate, utcHour) {
  const m = DATE_RE.exec(String(openingDate || '').slice(0, 10));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  // Date.UTC silently rolls impossible dates over (month 13 -> next February),
  // so check the calendar date round-trips before trusting it.
  const opening = new Date(Date.UTC(y, mo, d));
  if (opening.getUTCFullYear() !== y || opening.getUTCMonth() !== mo || opening.getUTCDate() !== d) return null;
  return new Date(Date.UTC(y, mo, d + 1, utcHour));
}

/** When the overdue page fires for this opening date (null if unparseable). */
function overdueAlertAt(openingDate) {
  return dayAfterOpeningAt(openingDate, OVERDUE_ALERT_UTC_HOUR);
}

/** When the draft is forced past the gates for this opening date (null if unparseable). */
function draftDeadlineAt(openingDate) {
  return dayAfterOpeningAt(openingDate, DRAFT_DEADLINE_UTC_HOUR);
}

/**
 * Shows whose draft deadline has passed and that are still owed a draft.
 *
 * @param {object} p
 * @param {string[]} p.showIds candidate ids (the workflow's pending set)
 * @param {object[]} p.shows shows.json rows
 * @param {object} p.sentShows opening-night-sent.json `.shows`
 * @param {object[]} [p.newsletterIssues] newsletter-state.json `.issues`
 * @param {number} [p.nowMs]
 * @returns {{id: string, deadlineAt: string}[]}
 */
function pastDeadlineShows({ showIds, shows, sentShows, newsletterIssues = [], nowMs = Date.now() }) {
  const byId = new Map((shows || []).map(s => [s.id, s]));
  const sent = sentShows || {};
  const out = [];
  for (const id of showIds || []) {
    if (!id) continue;
    const show = byId.get(id);
    if (!show) continue;
    const deadline = draftDeadlineAt(show.openingDate);
    if (!deadline || nowMs < deadline.getTime()) continue;
    // Same "still owed" rule the send script applies (a cancelled or failed draft
    // re-queues after its cooldown, and a healthy draft is never re-created).
    if (!shouldRequeueShow(sent[id], nowMs)) continue;
    // ...unless a sibling record of the same draft already observed the send
    // (the per-show mirror can be stale; BRO-4474).
    if (sentOnSiblingRecord(sent, id)) continue;
    // BRO-3088: the owner declined individual West End sends once the Weekly
    // Round-up covered the show, so a deadline must not force one.
    if (show.category === 'west-end' && wasCoveredByWeeklyRoundup(newsletterIssues, id)) continue;
    out.push({ id, deadlineAt: deadline.toISOString() });
  }
  return out;
}

module.exports = {
  OVERDUE_ALERT_UTC_HOUR,
  DRAFT_DEADLINE_UTC_HOUR,
  overdueAlertAt,
  draftDeadlineAt,
  pastDeadlineShows,
};
