'use strict';

/**
 * Whether a page found by url discovery (a SERP hit for a dead stored url)
 * may replace the stored url and text (BRO-5183).
 *
 * The page was not chosen by any aggregator or human, only by a search, so it
 * must pass the content verifier outright: a verdict exists, the verifier
 * called it valid, and it flagged no wrong production, wrong article or
 * film/TV piece. No verdict (under 200 words, or the verifier threw) is a
 * refusal: the search has to prove the page, not the other way round.
 * Seen: a 2018 Kennedy Center touring review of Something Rotten! stored for
 * the 2015 Broadway production with no verification at all.
 * Pure, no I/O.
 */
function discoveredPageVerdict(cv) {
  if (!cv) return { accept: false, reason: 'no content verification (too short or verifier unavailable)' };
  if (cv.wrongProduction) return { accept: false, reason: 'verifier: wrong production' };
  if (cv.wrongArticle) return { accept: false, reason: 'verifier: wrong article' };
  if (cv.isFilmTv) return { accept: false, reason: 'verifier: film/TV piece' };
  if (cv.isValid !== true) return { accept: false, reason: 'verifier: not valid' + (cv.issues && cv.issues[0] ? ` (${cv.issues[0]})` : '') };
  return { accept: true, reason: 'verified' };
}

module.exports = { discoveredPageVerdict };
