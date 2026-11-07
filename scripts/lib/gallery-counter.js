'use strict';
/**
 * Photo-gallery slide counters read as ratings (BRO-305).
 *
 * Evening Standard article pages carry an inline gallery whose counter ("1/5",
 * "1/10", "1/50": slide 1 of N) lands in the scraped text as a line of its own,
 * between the related-article links. The LLM extractor took it as the critic's
 * rating twice: American Buffalo (WE 2015) stored 1/5 on a positive review, and
 * The Lehman Trilogy (WE 2018) stored 1/10, anchored the scorer to it and shipped
 * 20 on a warm review.
 *
 * The corpus (80K review texts, 2026-11-04) has 43 standalone "1/N" lines and
 * not one is a rating: the only real standalone fraction is a London Theatre
 * "4/5". A static page always renders slide 1, so the rule is narrow: numerator
 * exactly 1, the fraction alone on its line, nothing else on it.
 */

// A line holding only "1/N" (optional spaces), N = 1..99.
const COUNTER_LINE_RE = /^[ \t]*1[ \t]*\/[ \t]*(\d{1,2})[ \t\r]*$/gm;

// A label line just above ("Rating:", "Our verdict", "Stars:") makes the 1/N its value.
const RATING_LABEL_RE = /\b(?:rating|rated|verdict|score|stars?|grade)\s*:?\s*$/i;

/** True when the nearest non-blank line before `lineStart` is a rating label. */
function followsRatingLabel(text, lineStart) {
  const before = text.slice(Math.max(0, lineStart - 200), lineStart).replace(/\s+$/, '');
  const prevLine = before.slice(before.lastIndexOf('\n') + 1);
  return RATING_LABEL_RE.test(prevLine);
}

/** True when `text` holds a standalone "1/<denominator>" line. */
function hasCounterLine(text, denominator) {
  if (typeof text !== 'string' || !text) return false;
  for (const m of text.matchAll(COUNTER_LINE_RE)) {
    if (denominator == null || Number(m[1]) === Number(denominator)) return true;
  }
  return false;
}

/**
 * True when the regex match at [index, index+length) is a whole standalone
 * "1/N" line of `text` (the gallery-counter shape), not a rating in prose.
 */
function isGalleryCounterAt(text, index, length) {
  if (typeof text !== 'string' || !Number.isInteger(index) || !Number.isInteger(length)) return false;
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  let lineEnd = text.indexOf('\n', index + length);
  if (lineEnd < 0) lineEnd = text.length;
  // \r stays in the slice on CRLF text; treat it as line whitespace.
  if (!/^[ \t\r]*1[ \t]*\/[ \t]*\d{1,2}[ \t\r]*$/.test(text.slice(lineStart, lineEnd))) return false;
  return !followsRatingLabel(text, lineStart);
}

/**
 * True when a rating string (an LLM `raw`, or a stored originalScore) is a bare
 * "1/N" fraction (optionally "stars"), and that fraction appears in `text` only
 * as a standalone counter line with no rating label above it.
 */
function isGalleryCounterRating(rating, text) {
  if (typeof rating !== 'string' || typeof text !== 'string') return false;
  // The LLM's raw and the stored string often add "stars" the page never printed.
  const m = /^\s*1\s*\/\s*(\d{1,2})(?:\s*stars?)?\s*$/i.exec(rating);
  if (!m) return false;
  // Every standalone 1/N line must be a counter (not a "Rating:" label's value).
  let counter = false;
  for (const c of text.matchAll(COUNTER_LINE_RE)) {
    if (Number(c[1]) !== Number(m[1])) continue;
    if (followsRatingLabel(text, c.index)) return false;
    counter = true;
  }
  if (!counter) return false;
  // The same fraction inside a sentence ("I give it 1/5", "1/5 stars") is a real rating. Digit,
  // slash and letter boundaries keep run dates ("Until 11/5", "1/5/2015") and "1/5th" out.
  const inline = new RegExp(`(?<![\\d/])1[ \\t]*\\/[ \\t]*${m[1]}(?![\\d/A-Za-z])`);
  return !inline.test(text.replace(COUNTER_LINE_RE, ''));
}

module.exports = { hasCounterLine, isGalleryCounterAt, isGalleryCounterRating };
