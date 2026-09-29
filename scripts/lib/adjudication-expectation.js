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
      contextNote: 'Background mentions of the original Broadway run, its cast or its New York reviews are NOT evidence this review is ABOUT the Broadway production — tour reviews routinely compare with Broadway. Only mark "wrong-market" when the review\'s own opinion-bearing content (the critic\'s actual assessment) is evaluating a performance the critic attended in New York or at a non-touring staging.',
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
  const contextNote = `A FORWARD-LOOKING mention of a future tour ("before it embarks on a national tour", "which will then transfer to...", "ahead of its upcoming tour") is NOT evidence this review is ABOUT a tour production — it is background context in a review of the CURRENT ${expectedType} run. Only mark "wrong-market" when the review's own opinion-bearing content (the critic's actual assessment) is evaluating a performance the critic attended at a different venue/production — not when it merely name-checks a later tour in passing.`;
  return { expectedType, wrongTypes, contextNote };
}

module.exports = { adjudicationExpectation };
