/**
 * The one place that answers "what should this show's stored title be?"
 * (BRO-3863).
 *
 * Two independent scrape artifacts corrupt stored titles:
 *
 *   1. a venue/company appended by the source as a disambiguator
 *      ("The Cherry Orchard (Park Avenue Armory)")    -> title-venue-suffix.js
 *   2. a heading captured from a source that doesn't preserve true casing
 *      ("AMERICA, WHO HURT YOU?")                     -> title-display-case.js
 *
 * BRO-3920 retired algorithmic title-casing as a fix for (2): guessing a
 * casing from the shouted string alone already shipped wrong output
 * ("JUST FOR US" -> "Just for US", "MAN OF LA MANCHA" -> "Man of LA
 * Mancha"). The only trustworthy fix is re-deriving the title from the
 * source's structured metadata (JSON-LD `name` / `og:title`), which is an
 * ingestion-side concern, not something this normaliser can do after the
 * fact from the string alone. So step 2 here is DETECTION ONLY: it flags a
 * shouted title as needing a human to look up the source and either correct
 * the stored title or, if the caps are genuinely correct branding, add the
 * show id to KEEP_SHOUTED_IDS (title-display-case.js). It never rewrites.
 *
 * The venue-suffix step (1) is unaffected — stripping a known, matched venue
 * name is a deterministic transform, not a guess.
 *
 * ORDER MATTERS, and the corpus proves it. "THIS IS NOT ABOUT ME. (59E59
 * Theaters)" is NOT detected as shouted, because "Theaters" inside the
 * parenthetical supplies lowercase letters. Strip the venue first and
 * "THIS IS NOT ABOUT ME." is plainly shouted. Run the detector first and it
 * never fires. So: venue suffix, THEN shouted-casing detection.
 *
 * Every caller — the ingestion path in discover-new-shows.js, the corpus
 * sweep in fix-show-titles.js, and the validate-data.js gate — goes through
 * this function, so the audit, the guard and the writer can never disagree
 * about what a correct title is. That equivalence is the whole point; see
 * memory/feedback_includability_predicates_must_be_canonical.md.
 */

'use strict';

const { classifyVenueSuffix, buildVenueVocabulary } = require('./title-venue-suffix');

// A title with more trailing parentheticals than this is not a title.
const MAX_VENUE_STRIP_PASSES = 4;
const {
  isShoutedTitle,
  isExemptFromTitleCase,
} = require('./title-display-case');

/**
 * @param {{id?:string, title:string, venue?:string}} show
 * @param {{venueVocabulary?: string[]}} [ctx]
 * @returns {{
 *   title: string,            // what the title SHOULD be (venue-suffix repairs only)
 *   changed: boolean,
 *   manualReview: boolean,    // shouted casing detected — a human owes us a source lookup
 *   steps: Array<{kind:'venue-suffix', from:string, to:string, oracle?:string}>
 * }}
 */
function normalizeShowTitle(show, ctx = {}) {
  const steps = [];
  let title = show && typeof show.title === 'string' ? show.title : '';
  const original = title;
  if (!title) return { title, changed: false, manualReview: false, steps };

  // 1. venue / producing-company suffix — to a FIXED POINT, not once.
  // "A Play (Luna Stage) (Soho Playhouse)" needs two passes, and a single
  // pass left the sweep reporting success while validate-data.js still
  // failed on the same row (adversarial review finding, reproduced). Bounded
  // so a pathological title cannot spin.
  for (let pass = 0; pass < MAX_VENUE_STRIP_PASSES; pass++) {
    const venueResult = classifyVenueSuffix(title, {
      id: show.id,
      venue: show.venue,
      venueVocabulary: ctx.venueVocabulary,
    });
    if (venueResult.action !== 'strip') break;
    steps.push({ kind: 'venue-suffix', from: title, to: venueResult.title, oracle: venueResult.oracle });
    title = venueResult.title;
  }

  // 2. shouted casing, on the now-stripped title — DETECT, never guess-fix.
  const manualReview = isShoutedTitle(title) && !isExemptFromTitleCase(show.id, title);

  return { title, changed: title !== original, manualReview, steps };
}

module.exports = {
  normalizeShowTitle,
  MAX_VENUE_STRIP_PASSES,
  buildVenueVocabulary,
  isExemptFromTitleCase,
};
