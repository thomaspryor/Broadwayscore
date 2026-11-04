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
const COUNTER_LINE_RE = /^[ \t]*1[ \t]*\/[ \t]*(\d{1,2})[ \t]*$/gm;

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
  return /^[ \t]*1[ \t]*\/[ \t]*\d{1,2}[ \t]*$/.test(text.slice(lineStart, lineEnd));
}

/**
 * True when a rating string (an LLM `raw`, or a stored originalScore) is a bare
 * "1/N" fraction with no rating words or star glyphs, and that fraction appears
 * in `text` only as a standalone counter line.
 */
function isGalleryCounterRating(rating, text) {
  if (typeof rating !== 'string') return false;
  const m = /^\s*1\s*\/\s*(\d{1,2})\s*$/.exec(rating);
  if (!m) return false;
  if (!hasCounterLine(text, m[1])) return false;
  // The same fraction used inside a sentence ("1/5 stars", "rated 1/5") is a real rating.
  const inline = new RegExp(`\\S[ \\t]*1[ \\t]*\\/[ \\t]*${m[1]}(?!\\d)|(?<!\\d)1[ \\t]*\\/[ \\t]*${m[1]}[ \\t]*\\S`);
  return !inline.test(text.replace(COUNTER_LINE_RE, ''));
}

module.exports = { hasCounterLine, isGalleryCounterAt, isGalleryCounterRating };
