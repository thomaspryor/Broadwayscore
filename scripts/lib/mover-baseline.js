/**
 * Guards for the weekly newsletter's "Biggest Mover" card.
 *
 * Bug (owner, 2026-11-15): Wanted opened Sun Nov 8 and its opening-night email
 * went to readers on Nov 9 with a score of 60 (20 reviews). The Nov 9 weekly
 * then showed "Wanted 66 -> 59, down 7 pts". 66 was an average of only the
 * handful of reviews dated before the week started; readers never saw it. The
 * published score had not moved. The owner deleted the card by hand.
 *
 * Two rules, both pure so they can be tested:
 *  1. A show that opened within the opening-review window is settling, not
 *     "moving". Not a mover.
 *  2. If we already told readers a score for the show (opening-night email),
 *     movement is judged from that published number, never from a number we
 *     recomputed. No real move from it, no card.
 */
const OPENING_WINDOW_DAYS = 14;
const MIN_MOVE_PTS = 3;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Score readers were last told, from opening-night-sent.json `.shows`; null if none. */
function publishedScoreFor(sentShows, showId) {
  if (!sentShows) return null;
  for (const key of [`broadway:${showId}`, showId]) {
    const rec = sentShows[key];
    if (!rec || rec.draftStatus !== 'sent') continue;
    const n = rec.draftNumbers && rec.draftNumbers[showId];
    if (n && Number.isFinite(n.score)) return n.score;
  }
  return null;
}

/**
 * @returns {{suppress:true, reason:string} | {suppress:false, before:number}}
 *   `before` is the baseline the card must display.
 */
function moverBaseline({ show, weekStartStr, weekEndStr, before, after, publishedScore }) {
  if (show.openingDate && show.openingDate >= addDays(weekStartStr, -OPENING_WINDOW_DAYS) && show.openingDate <= weekEndStr) {
    return { suppress: true, reason: 'opening-window' };
  }
  if (publishedScore != null) {
    if (Math.abs(Math.round(after) - Math.round(publishedScore)) < MIN_MOVE_PTS) {
      return { suppress: true, reason: 'published-score-holds' };
    }
    return { suppress: false, before: Math.round(publishedScore) };
  }
  return { suppress: false, before: Math.round(before) };
}

module.exports = { moverBaseline, publishedScoreFor, OPENING_WINDOW_DAYS, MIN_MOVE_PTS };
