'use strict';

/**
 * byline-attestation.js — is a review's byline printed as a byline in its own
 * article text?
 *
 * WHY THIS EXISTS (BRO-3247, 2026-09-15). When two review-text files share one
 * URL, dedupe-same-url-bylines.js collapses them via chooseCanonicalForRebuild.
 * If both members look equally good — both includable, both scored, both with a
 * plausible human byline, same publishDate — every tiebreak fell through to
 * ALPHABETICAL FILENAME ORDER. On Safe House that crowned a scraper-invented
 * byline ("Scott Bennett", absent from the article) over the real one ("Victor
 * Gluck", printed as "Posted on September 7, 2026 by Victor Gluck") purely
 * because "scott" sorts before "victor" — and the REAL review was then marked
 * duplicateOf the phantom and suppressed from the site.
 *
 * The article text is the evidence nothing was consulting: a byline the scraper
 * invented is essentially never printed, while the true byline almost always is.
 *
 * THIS IS A LAST-RESORT TIEBREAK, so a wrong "attested" verdict is worse than an
 * "unknown" one. Four deliberate conservatisms, each from a real failure mode
 * found by /second-opinion on the first revision of this file:
 *
 *  1. BYLINE CONTEXT REQUIRED, not bare containment. The name must follow a
 *     byline marker ("by", "posted by", "reviewed by", "words by", …). Critics
 *     are named inside review prose all the time — a mere mention is not a
 *     byline.
 *  2. TOKEN BOUNDARIES. Bare String.includes made "Ann Lee" match "Mary Ann
 *     Leech" and "Sam Well" match "Sam Wells". Both sides are space-padded so a
 *     match must start and end on a token boundary.
 *  3. SINGLE-TOKEN NAMES NEVER ATTEST. "Ross" is a real frontmezzjunkies
 *     byline; one common word proves nothing.
 *  4. EACH FILE IS JUDGED ON ITS OWN TEXT. An earlier revision searched both
 *     files' text as one blob, which let one file's site-wide editor credit
 *     (theaterscene.net prints "by Victor Gluck, Editor-in-Chief" on pages
 *     other people wrote) attest the OTHER file's invented byline. It also made
 *     the pairwise fold over 3+ member groups order-dependent, since the blob
 *     changed per pair.
 *
 * Accent/apostrophe folding reuses foldDiacritics from title-match.js — real
 * bylines carry apostrophes and diacritics ("O'Hara", "Oñions") and \b-style
 * word boundaries break on exactly those
 * (memory/feedback_word_boundary_punct_titles.md).
 */

const { foldDiacritics } = require('./title-match');

// Byline markers that may introduce a name. Matched against the NORMALIZED
// text, so they are plain lowercase words. "posted on <date> by X" and
// "review by X" both reduce to a trailing " by " before the name.
const BYLINE_MARKERS = [
  'by',
  'byline',
  'author',
  'written by',
  'reviewed by',
  'words by',
  'reporting by',
  'photographs by',
];

/**
 * Fold text to a comparable form: diacritics stripped, lowercased, apostrophes
 * DROPPED (so "O'Hara" folds to "ohara" on both sides rather than splitting),
 * every other non-alphanumeric run collapsed to a single space, and the result
 * space-padded so callers can test token boundaries with a plain includes().
 *
 * @param {string} s
 * @returns {string} normalized text, or '' when unusable
 */
function normalizeForAttestation(s) {
  if (!s || typeof s !== 'string') return '';
  const folded = foldDiacritics(s)
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return folded;
}

/**
 * True when `criticName` appears in `text` immediately after a byline marker.
 *
 * @param {string|null|undefined} criticName
 * @param {string|null|undefined} text - the article's own fullText
 * @returns {boolean} false for absent/unusable input or a single-token name
 */
function isBylineAttestedInText(criticName, text) {
  const name = normalizeForAttestation(criticName);
  if (!name) return false;
  // Conservatism 3: one token is too weak a signal to act on.
  if (name.split(' ').length < 2) return false;

  const body = normalizeForAttestation(text);
  if (!body) return false;

  // Conservatism 1 + 2: the name must follow a byline marker AND land on token
  // boundaries. Padding both sides means " by victor gluck " can only match a
  // whole-token run, never "...by victor gluckman...".
  const padded = ` ${body} `;
  for (const marker of BYLINE_MARKERS) {
    if (padded.includes(` ${marker} ${name} `)) return true;
  }
  return false;
}

module.exports = { normalizeForAttestation, isBylineAttestedInText, BYLINE_MARKERS };
