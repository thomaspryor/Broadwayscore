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
  // No verdict is not evidence against the page (an API outage, a capsule
  // review under 200 words): `retry` tells the caller not to count it.
  if (!cv) return { accept: false, retry: true, reason: 'no content verification (too short or verifier unavailable)' };
  // Same bar the main path acts on (updateReviewJson): the temporal and
  // in-window overrides lower a false wrongProduction to 'low' on purpose.
  const wrongProductionCounts = cv.wrongProduction && (cv.confidence === 'high' || cv.confidence === 'medium');
  if (wrongProductionCounts) return { accept: false, reason: 'verifier: wrong production' };
  if (cv.wrongArticle) return { accept: false, reason: 'verifier: wrong article' };
  if (cv.isFilmTv) return { accept: false, reason: 'verifier: film/TV piece' };
  if (cv.isValid !== true && !(cv.wrongProduction && !wrongProductionCounts)) return { accept: false, reason: 'verifier: not valid' + (cv.issues && cv.issues[0] ? ` (${cv.issues[0]})` : '') };
  return { accept: true, reason: 'verified' };
}

module.exports = { discoveredPageVerdict };
