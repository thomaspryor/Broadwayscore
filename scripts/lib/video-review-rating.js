/**
 * Explicit ratings in video reviews (BRO-6091).
 *
 * Kate Reinking ended her Heathers review with "10 out of 10, would recommend"
 * and we published 77. score-video-reviews.js asks the model to report the
 * creator's own overall rating; anchorScore() then keeps the score inside the
 * band that rating maps to, the same star bands as text reviews (CLAUDE.md §3:
 * 2/5 -> 31-50, 3/5 -> 51-70, 4/5 -> 71-90, 5/5 -> 91-100).
 * Pure so tests can require() it (CLAUDE.md §15).
 */

// Rough pre-filter for transcripts scored before the rating rule: worth a
// rescore only if something rating-shaped is said. The model decides whether
// it is an overall rating of the show.
const RATING_MENTION_RE = /\b(?:10|\d(?:\.5)?)\s*(?:out of|\/)\s*10\b|\b[0-5](?:\.5)?\s*(?:out of|\/)\s*5\b|\b(?:[1-5](?:\.5)?|one|two|three|four|five)\s*stars?\b/i;

function mentionsRating(text) {
  return RATING_MENTION_RE.test(String(text || ''));
}

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/**
 * "10/10", "9 out of 10", "4.5/5", "4 stars", "four stars" -> fraction 0-1.
 * Anything else (null, "none", "8/10 for the cast") -> null.
 */
function parseRating(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase()
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, w => String(WORD_NUMBERS[w]))
    // "4.5 stars out of 5", "4 out of 5 stars" -> "4.5/5", "4/5"
    .replace(/^(\d+(?:\.\d+)?)\s*stars?\s+out of\s+(\d+)$/, '$1/$2')
    .replace(/^(\d+(?:\.\d+)?)\s*out of\s*(\d+)\s*stars?$/, '$1/$2');
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+)$/);
  if (m) {
    const num = Number(m[1]), den = Number(m[2]);
    if (!(den === 5 || den === 10) || num < 0 || num > den) return null;
    return num / den;
  }
  m = s.match(/^(\d(?:\.\d+)?)\s*stars?$/);
  if (m && Number(m[1]) <= 5) return Number(m[1]) / 5;
  return null;
}

/** Score band for a rating fraction: 5 stars 91-100, 4 stars 71-90, etc. */
function ratingBand(fraction) {
  const stars = fraction * 5;
  return { min: Math.max(0, Math.round(stars * 20 - 9)), max: Math.min(100, Math.round(stars * 20 + 10)) };
}

// Same buckets as the score-video-reviews.js prompt table and the text-review
// rebuild: one threshold set (score-extractors.js scoreToBucket).
const { scoreToBucket } = require('./score-extractors');
const videoBucketForScore = scoreToBucket;

/**
 * Keep a model score inside the creator's own rating band. The bucket always
 * comes from the final score: the model once returned 68 "Positive" (the
 * Mixed band), published as a mismatched label (BRO-6095).
 * @returns {{score: number, bucket: string, anchored: boolean, rating: number|null}}
 */
function anchorScore(score, bucket, rawRating) {
  const rating = parseRating(rawRating);
  const fromScore = s => (typeof s === 'number' ? videoBucketForScore(s) : bucket);
  if (rating === null || typeof score !== 'number') return { score, bucket: fromScore(score), anchored: false, rating };
  const { min, max } = ratingBand(rating);
  const clamped = Math.min(max, Math.max(min, score));
  return { score: clamped, bucket: fromScore(clamped), anchored: clamped !== score, rating };
}

module.exports = { mentionsRating, parseRating, ratingBand, videoBucketForScore, anchorScore };
