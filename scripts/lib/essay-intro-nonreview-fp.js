/**
 * Essay-intro isNonReview false-positive detector (BRO-57).
 *
 * The gemini classifier in classify-non-reviews.js keys off the OPENING of
 * fullText. Some genuine reviews (mostly outlet house-style pieces) open with
 * a long biographical/personal-essay intro before ever mentioning the show —
 * the classifier reads that opening, calls it a 'preview'/'interview'/'profile',
 * and the review is silently excluded even though the back half is a real,
 * scoreable review that names the show + venue and closes with an explicit
 * recommendation.
 *
 * Two confirmed real-corpus instances, manually verified 2026-07-19:
 *   - dolly-a-true-original-musical-regional-2025/music-city-review--gimena-cante.json
 *     (nonReviewType: 'preview' — opens with a Dolly Parton bio)
 *   - little-bear-ridge-road-regional-2024/around-the-town-chicago--alan-bresloff.json
 *     (nonReviewType: 'interview' — review is followed by a companion interview
 *     transcript in the same fullText blob)
 * Both were 86-88 scored reviews sitting excluded. This module's predicate is
 * the exact shape their manual verification used: soft (non-definitive)
 * nonReviewType, substantial text, show title mentioned, venue mentioned (when
 * a venue is on file), and an explicit recommendation in the closing stretch
 * of the text.
 *
 * Deliberately excludes the definitive junk types (press_release, cast_
 * announcement, listicle, awards_coverage, photo_gallery, obituary, and the
 * wrong-page newspaper OCR classes) — auto-clearing those is a different,
 * much riskier bet than this confirmed FP class.
 *
 * Ship-check adversarial review (BRO-57) found the original title+venue+
 * ending-recommendation gate alone also matches a GENUINE preview article
 * ("5 things to know before Show opens at Venue", closing with "this looks
 * like a must-see production") — promotional closers use the exact same
 * language a review's verdict does. Two more gates close that hole:
 *   - REVIEW_LANGUAGE_PATTERNS: requires at least one phrase that a preview
 *     piece (written before anyone has seen the show) essentially never
 *     uses — "curtain call", "standing ovation", "the performance is/was",
 *     a star rating, etc. Both ground-truth files hit this via "directed by".
 *   - PREVIEW_DISQUALIFIERS: forward-looking preview language ("before it
 *     opens", "what to expect", "previews begin") anywhere in the text
 *     disqualifies — a review of a show already seen doesn't talk about it
 *     this way. Deliberately narrower than non-review-patterns.js's full
 *     press_release set: that set's ticketing phrases ("available at the
 *     box office") appear verbatim in the little-bear-ridge-road ground-
 *     truth file's own listings paragraph, so reusing it wholesale would
 *     have broken a confirmed true positive.
 *
 * Consumers: scripts/audit-exclusion-flags.js, tests/unit/essay-intro-nonreview-fp.test.mjs.
 */

'use strict';

// Types the gemini classifier assigns that are structurally close to "essay/
// interview framing wrapped around a genuine review" — as opposed to content
// that is definitively NOT a review no matter how it reads.
const SOFT_NONREVIEW_TYPES = new Set(['preview', 'interview', 'profile', 'bio', 'news_article']);

// At least one of these must appear somewhere in the text — a preview/press
// piece written before anyone has attended a performance essentially never
// uses this language, so it separates "genuine review with a bad intro"
// from "genuine preview with a promotional closer" (both otherwise pass the
// title+venue+recommendation gate below).
const REVIEW_LANGUAGE_PATTERNS = [
  /\b(?:directed by|written by|choreographed by)\b/i,
  /(?:opened? (?:last|this) (?:night|week)|opening night)/i,
  /(?:the (?:production|performance|staging|direction) (?:is|was|feels?))/i,
  /\b(?:brilliantly|masterfully|unfortunately|disappointing|thrilling|riveting|stunning)\b/i,
  /\b(?:curtain call|standing ovation|intermission)\b/i,
  /\d\s*(?:out of|\/)\s*(?:5|10|4)\s*stars?/i,
  /(?:stars?|rating|grade):\s*[A-F\d]/i,
];

// Forward-looking language a review of a show already seen doesn't use.
// Presence anywhere disqualifies, regardless of how strong the other signals
// are — see the module docstring for why this is narrower than the full
// non-review-patterns.js press_release/preview_article set.
const PREVIEW_DISQUALIFIERS = [
  /\bwhat to expect\b/i,
  /\bfirst look at\b/i,
  /\bsneak peek\b/i,
  /\bbefore (?:it|the show) opens\b/i,
  /\bpreviews? begins?\b/i,
  /\bis pleased to announce\b/i,
  /\btickets? (?:are\s+)?(?:now\s+)?on sale\b/i,
];

const RECOMMENDATION_PATTERNS = [
  /\bshould(?:n't| not)? miss\b/i,
  /\bmust[-\s]see\b/i,
  /\bdon'?t miss\b/i,
  /\bworth (?:seeing|catching|the trip|a trip|the ticket|the price)\b/i,
  /\bhighly recommend/i,
  /\byou(?:'ll| will) be glad\b/i,
  /\bgo see (?:it|this)\b/i,
  /\bcatch (?:it|this) (?:if|while)\b/i,
  /\byou should (?:see|watch|go)\b/i,
  /\btreat (?:yourself|to)\b/i,
  /\ba (?:real |true )?treat\b/i,
  /\bno theater(?:goer)?\s*(?:—|-|\bor\b)?[^.]{0,40}should miss\b/i,
];

const MIN_WORD_COUNT = 400;
// Scan the trailing fraction of the text for a recommendation — the intro is
// the problem, the ending is where the real verdict lives.
const ENDING_WINDOW_FRACTION = 0.35;

function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words so common in theater venue/show names that matching on them alone
// proves nothing — "The Public Theater", "Community Playhouse" reduce to
// tokens that appear in nearly any piece of theater journalism. Stripped
// before the token-overlap fallback so it can't manufacture a "mention" out
// of pure genericness (ship-check adversarial review, BRO-57).
const GENERIC_VENUE_TITLE_WORDS = new Set([
  'the', 'and', 'of', 'at', 'theater', 'theatre', 'playhouse', 'company',
  'center', 'centre', 'stage', 'public', 'arts', 'performing', 'hall',
  'house', 'musical', 'play', 'production',
]);

function significantTokens(normalized, minLen) {
  return normalized.split(' ').filter((t) => t.length >= minLen && !GENERIC_VENUE_TITLE_WORDS.has(t));
}

/**
 * Does the normalized fullText plausibly mention `raw` (a show title or venue
 * name)? Exact substring first (handles most cases); falls back to a
 * majority-of-significant-tokens match so punctuation/subtitle drift
 * ("Dolly: A True Original Musical" vs "DOLLY: An True Original Musical")
 * doesn't sink an otherwise-solid match. The fallback only fires on tokens
 * that survive GENERIC_VENUE_TITLE_WORDS filtering — a title/venue made up
 * entirely of generic words has no fallback and must match verbatim.
 */
function isMentioned(fullTextNorm, raw, { minTokenLen = 4, minTokenRatio = 0.6 } = {}) {
  const norm = normalizeForMatch(raw);
  if (!norm) return false;
  if (fullTextNorm.includes(norm)) return true;
  const tokens = significantTokens(norm, minTokenLen);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => fullTextNorm.includes(t)).length;
  return hits / tokens.length >= minTokenRatio;
}

function deriveShowTitle(data, showId) {
  if (data.showTitle) return data.showTitle;
  return String(showId || '')
    .replace(/-(?:regional|off-broadway|off-west-end|west-end|broadway)?-?\d{4}$/i, '')
    .replace(/-/g, ' ');
}

function deriveVenueCore(venue) {
  if (!venue) return null;
  // Venue strings are usually "Venue Name, City, ST" — the city/state suffix
  // is noise for a mention check (a review rarely repeats "Nashville, TN"
  // verbatim near the venue name).
  return String(venue).split(',')[0].trim();
}

function hasEndingRecommendation(fullText) {
  const start = Math.max(0, Math.floor(fullText.length * (1 - ENDING_WINDOW_FRACTION)));
  // Curly quotes are common in scraped text ("You’ll be glad", "don’t miss") —
  // normalize to straight apostrophes so the patterns above (which use ') match
  // both. This is a real corpus miss, not theoretical: the little-bear-ridge-
  // road ground-truth fixture uses U+2019 in "You'll be glad you did."
  const tail = fullText.slice(start).replace(/[‘’]/g, "'");
  return RECOMMENDATION_PATTERNS.some((p) => p.test(tail));
}

/**
 * @param {object} data - Review-text JSON (parsed).
 * @param {string} [showId] - Show dir name, used as a showTitle fallback.
 * @returns {null | { wordCount: number, nonReviewType: string, venueChecked: boolean }}
 *   null when this file doesn't match the essay-intro FP shape; otherwise the
 *   signals that matched, for logging.
 */
function detectEssayIntroFalsePositive(data, showId) {
  if (!data || data.isNonReview !== true) return null;
  if (data.nonReviewManualClear === true) return null;
  if (!SOFT_NONREVIEW_TYPES.has(data.nonReviewType)) return null;

  // A pre-existing wrongArticle:true is an independent exclusion signal from
  // an unrelated content-verification pass. This predicate has no basis to
  // evaluate it, so it must not clear a file that carries one — applyClear()
  // would otherwise silently stamp wrongArticle:false over it (ship-check
  // adversarial review, BRO-57).
  if (data.contentVerification && data.contentVerification.wrongArticle === true) return null;

  const fullText = data.fullText || '';
  if (!fullText) return null;
  const wordCount = data.textWordCount || fullText.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORD_COUNT) return null;

  if (PREVIEW_DISQUALIFIERS.some((p) => p.test(fullText))) return null;
  if (!REVIEW_LANGUAGE_PATTERNS.some((p) => p.test(fullText))) return null;

  const fullTextNorm = normalizeForMatch(fullText);

  const title = deriveShowTitle(data, showId);
  if (!isMentioned(fullTextNorm, title)) return null;

  const venueCore = deriveVenueCore(data.venue);
  const venueChecked = !!venueCore;
  if (venueChecked && !isMentioned(fullTextNorm, venueCore)) return null;

  if (!hasEndingRecommendation(fullText)) return null;

  return { wordCount, nonReviewType: data.nonReviewType, venueChecked };
}

module.exports = {
  SOFT_NONREVIEW_TYPES,
  RECOMMENDATION_PATTERNS,
  REVIEW_LANGUAGE_PATTERNS,
  PREVIEW_DISQUALIFIERS,
  MIN_WORD_COUNT,
  detectEssayIntroFalsePositive,
};
