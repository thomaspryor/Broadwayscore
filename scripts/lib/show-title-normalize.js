/**
 * The one place that answers "what should this show's stored title be?"
 * (BRO-3863).
 *
 * Two independent scrape artifacts corrupt stored titles, and they COMPOSE —
 * which is why they need a single ordered entry point rather than two
 * call sites that each hope the other ran:
 *
 *   1. a venue/company appended by the source as a disambiguator
 *      ("The Cherry Orchard (Park Avenue Armory)")    -> title-venue-suffix.js
 *   2. a heading captured from CSS `text-transform: uppercase`
 *      ("AMERICA, WHO HURT YOU?")                     -> title-display-case.js
 *
 * ORDER MATTERS, and the corpus proves it. "THIS IS NOT ABOUT ME. (59E59
 * Theaters)" is NOT detected as shouted, because "Theaters" inside the
 * parenthetical supplies lowercase letters. Strip the venue first and
 * "THIS IS NOT ABOUT ME." is plainly shouted and converts to "This Is Not
 * About Me.". Run the de-shouter first and it is a no-op forever. So:
 * venue suffix, THEN case.
 *
 * Every caller — the ingestion path in discover-new-shows.js, the corpus
 * sweep in fix-show-titles.js, and the validate-data.js gate — goes through
 * this function, so the audit, the guard and the writer can never disagree
 * about what a correct title is. That equivalence is the whole point; see
 * memory/feedback_includability_predicates_must_be_canonical.md.
 */

'use strict';

const { classifyVenueSuffix, buildVenueVocabulary } = require('./title-venue-suffix');
const {
  classifyShowTitle,
  needsManualReview,
  isExemptFromTitleCase,
} = require('./title-display-case');

/**
 * @param {{id?:string, title:string, venue?:string}} show
 * @param {{venueVocabulary?: string[]}} [ctx]
 * @returns {{
 *   title: string,            // what the title SHOULD be
 *   changed: boolean,
 *   manualReview: boolean,    // a human still owes us a casing decision
 *   steps: Array<{kind:'venue-suffix'|'title-case', from:string, to:string, oracle?:string}>
 * }}
 */
function normalizeShowTitle(show, ctx = {}) {
  const steps = [];
  let title = show && typeof show.title === 'string' ? show.title : '';
  const original = title;
  if (!title) return { title, changed: false, manualReview: false, steps };

  // 1. venue / producing-company suffix
  const venueResult = classifyVenueSuffix(title, {
    venue: show.venue,
    venueVocabulary: ctx.venueVocabulary,
  });
  if (venueResult.action === 'strip') {
    steps.push({ kind: 'venue-suffix', from: title, to: venueResult.title, oracle: venueResult.oracle });
    title = venueResult.title;
  }

  // 2. shouted casing, on the now-stripped title
  const caseResult = classifyShowTitle(show.id, title);
  let manualReview = false;
  if (caseResult.action === 'convert') {
    steps.push({ kind: 'title-case', from: title, to: caseResult.title });
    title = caseResult.title;
  } else if (caseResult.action === 'manual-review') {
    manualReview = true;
  }

  return { title, changed: title !== original, manualReview, steps };
}

module.exports = {
  normalizeShowTitle,
  buildVenueVocabulary,
  needsManualReview,
  isExemptFromTitleCase,
};
