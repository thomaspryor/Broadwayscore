'use strict';

const { isLondonMarket } = require('./venue-classification');

/**
 * What production the contamination adjudicator (adjudicate-review-queue.js)
 * should expect for a show's category, and which productions count as wrong.
 * Extracted so the per-category wording is testable (BRO-4211): before the
 * `tour` case, a national-tour show fell through to "Broadway" and every tour
 * review in the queue was judged a wrong-market national-tour review.
 */
function adjudicationExpectation(category) {
  if (category === 'tour') {
    return {
      expectedType: 'national tour',
      wrongTypes: 'the original Broadway run in New York, a West End or UK production, a regional or community theatre staging, a pre-Broadway tryout, or a film/TV adaptation',
    };
  }
  const expectedType = category === 'off-broadway' ? 'Off-Broadway'
    : category === 'west-end' ? 'West End'
    : category === 'off-west-end' ? 'Off-West End'
    : 'Broadway';
  const wrongTypes = category === 'off-broadway'
    ? 'national tour, regional theater, film/TV adaptation, streaming special, or a BROADWAY (not Off-Broadway) production'
    : isLondonMarket(category)
    ? 'national tour, regional theater, film/TV adaptation, streaming special, or a Broadway/Off-Broadway (not West End) production'
    : 'national tour, regional theater, pre-Broadway tryout, film/TV adaptation, streaming special';
  return { expectedType, wrongTypes };
}

module.exports = { adjudicationExpectation };
