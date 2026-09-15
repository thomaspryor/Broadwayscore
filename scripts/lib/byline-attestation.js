'use strict';

/**
 * byline-attestation.js — does a review's byline actually appear in the
 * article's own text?
 *
 * WHY THIS EXISTS (BRO-3247, 2026-09-15). When two review-text files share one
 * URL, dedupe-same-url-bylines.js collapses them via chooseCanonicalForRebuild.
 * If both members look equally good — both includable, both scored, both with a
 * plausible human byline, same publishDate — every tiebreak fell through to
 * ALPHABETICAL FILENAME ORDER. On Safe House that crowned a scraper-invented
 * byline ("Scott Bennett", a name that appears nowhere in the article) over the
 * real one ("Victor Gluck", printed in the article's own "Posted on ... by
 * Victor Gluck, Editor-in-Chief" line) purely because "scott" sorts before
 * "victor" — and the REAL review was marked duplicateOf the phantom.
 *
 * The article text is the available evidence nothing was consulting: a byline
 * the scraper invented is essentially never printed in the body, while the true
 * byline almost always is.
 *
 * Deliberately conservative — this is a LAST-RESORT tiebreak, so a wrong
 * "attested" verdict is worse than an "unknown" one:
 *   - Single-token names ("Ross", a real frontmezzjunkies byline) never count
 *     as attested. One common word matching proves nothing.
 *   - Matching is accent- and punctuation-insensitive. Real bylines carry
 *     apostrophes and diacritics ("O'Hara", "Beatrice Oñions") and \b-style
 *     word boundaries break on exactly those (see
 *     memory/feedback_word_boundary_punct_titles.md).
 *   - Requires the name's tokens to appear ADJACENTLY, so "David ... Spencer"
 *     scattered across a paragraph does not count.
 */

/**
 * Fold text to a comparable form: lowercase, strip diacritics, reduce every
 * non-alphanumeric run to a single space. Apostrophes are DROPPED rather than
 * spaced so "O'Hara" folds to "ohara" both in the name and in the text.
 * @param {string} s
 * @returns {string}
 */
function normalizeForAttestation(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining accents
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '') // apostrophes vanish, not split
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when `criticName` is printed in `text`.
 *
 * @param {string|null|undefined} criticName
 * @param {string|null|undefined} text - the article's fullText
 * @returns {boolean} false for absent/unusable input or a single-token name
 */
function isBylineAttestedInText(criticName, text) {
  const name = normalizeForAttestation(criticName);
  if (!name) return false;
  // One token is too weak a signal to act on — see the conservatism note above.
  if (name.split(' ').length < 2) return false;
  const body = normalizeForAttestation(text);
  if (!body) return false;
  return body.includes(name);
}

module.exports = { normalizeForAttestation, isBylineAttestedInText };
