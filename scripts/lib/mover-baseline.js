/**
 * Guard for the weekly newsletter's "Biggest Mover" card.
 *
 * Bug (owner, 2026-11-15): Wanted opened Sun Nov 8 and its opening-night email
 * went to readers on Nov 9 with a score of 60 (20 reviews). The Nov 9 weekly
 * then showed "Wanted 66 -> 59, down 7 pts". 66 was an average of only the
 * handful of reviews dated before the week started; readers never saw it. The
 * published score had not moved. The owner deleted the card by hand.
 *
 * Rule: a show that opened within the opening-review window is settling, not
 * "moving", so it is never a mover. The opening-night score is NOT used as a
 * baseline later: it goes stale within weeks (ship-check review, BRO-7567).
 */
const OPENING_WINDOW_DAYS = 14;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when the show opened (or reopened) from OPENING_WINDOW_DAYS before the week through its end. */
function inOpeningWindow(show, weekStartStr, weekEndStr) {
  const from = addDays(weekStartStr, -OPENING_WINDOW_DAYS);
  return [show.openingDate, show.reopeningDate].some(d => d && d >= from && d <= weekEndStr);
}

module.exports = { inOpeningWindow, OPENING_WINDOW_DAYS };
