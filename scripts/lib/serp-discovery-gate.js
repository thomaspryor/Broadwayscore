'use strict';
/**
 * Does the collector need SERP URL discovery before fetching this review?
 *
 * no_url, wrong_content and fabricated entries normally do: their stored url
 * is missing or was judged to point at the wrong article.
 *
 * Exception (BRO-6924): a wrong_content verdict a person overruled
 * (wrongProductionManualClear === true) with a url still stored. The url is
 * the one the person approved, so fetch it. Before this, three London ENO
 * Tosca reviews moved out of the Met folder by an approved fix kept their old
 * incompleteReason; the collector re-searched with the full show title,
 * found nothing, and never fetched the known-good url.
 *
 * A dateless-revival hold (BRO-4430) needs only its stored url's date: no SERP.
 *
 * @param {object} review
 * @returns {boolean}
 */
function needsSerpUrlDiscovery(review) {
  if (!review || review._datelessDateRetry) return false;
  if (review.fabricatedEntry) return true;
  if (review.incompleteReason === 'no_url') return true;
  if (review.incompleteReason === 'wrong_content') {
    // Only for a file no flag still marks: a live wrongProduction/wrongShow/
    // wrongAttribution beside the clear (56 such files on 2026-11-04, e.g. old
    // London reviews on Broadway shows) keeps the old search behaviour.
    const flagged = review.wrongProduction || review.wrongShow || review.wrongAttribution;
    return !(review.wrongProductionManualClear === true && !flagged
      && typeof review.url === 'string' && /^https?:\/\//.test(review.url));
  }
  return false;
}

module.exports = { needsSerpUrlDiscovery };
