/**
 * Pure helpers for the theatr-screenshot-import edge function: request
 * validation and cleanup of the model's extraction. Kept free of Deno and
 * network code so tests/unit/theatr-screenshot-normalize.test.mjs can
 * exercise it under plain node.
 *
 * The model output is UNTRUSTED (it reads user screenshots, which can carry
 * any text): structured outputs guarantee the shape, but every value is still
 * re-validated here before it reaches the client.
 */

export const MAX_IMAGES_PER_CALL = 6;
// ~1.5 MB decoded per image. Clients downscale to a 1568px long edge JPEG
// (~150-400 KB), so this only stops someone posting raw multi-MB PNGs.
export const MAX_IMAGE_BASE64_LEN = 2_000_000;
export const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_TITLE_LEN = 150;
const MAX_VENUE_LEN = 120;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validate the request body. Returns the image list or an error code from
 * the function's error contract ('invalid_images' | 'too_many_images').
 * @param {unknown} body
 * @returns {{ ok: true, images: { mediaType: string, data: string }[] } | { ok: false, error: string }}
 */
export function validateImages(body) {
  const images = body && typeof body === 'object' ? /** @type {any} */ (body).images : null;
  if (!Array.isArray(images) || images.length === 0) return { ok: false, error: 'invalid_images' };
  if (images.length > MAX_IMAGES_PER_CALL) return { ok: false, error: 'too_many_images' };
  const out = [];
  for (const img of images) {
    const mediaType = img && typeof img.mediaType === 'string' ? img.mediaType : '';
    const data = img && typeof img.data === 'string' ? img.data : '';
    if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) return { ok: false, error: 'invalid_images' };
    if (!data || data.length > MAX_IMAGE_BASE64_LEN || !BASE64_RE.test(data)) {
      return { ok: false, error: 'invalid_images' };
    }
    out.push({ mediaType, data });
  }
  return { ok: true, images: out };
}

/** True for a real YYYY-MM-DD calendar date (rejects 2024-02-30). */
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function cleanText(v, maxLen) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

/** Like cleanText but keeps paragraph breaks (a review's blank lines). */
function cleanParagraphs(v, maxLen) {
  if (typeof v !== 'string') return null;
  const s = v
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

const SCORE_RE = /(\d{1,3}(?:\.\d+)?)\s*(?:\/|out of)\s*(100|10|5)(?![\d.]*\d)/gi;

/**
 * Turn a score the user wrote ("84/100", "Score: 8.5/10!", "4 out of 5")
 * into 0-100. Only an explicit number over 5, 10 or 100 counts: a reaction
 * or a loose "loved it" is never turned into a score. When several appear,
 * the last one wins (reviews end with the verdict).
 * @returns {number|null}
 */
export function parseScoreText(text) {
  if (typeof text !== 'string') return null;
  let last = null;
  for (const m of text.matchAll(SCORE_RE)) last = m;
  if (!last) return null;
  const n = Number(last[1]);
  const d = Number(last[2]);
  if (!Number.isFinite(n) || n < 0 || n > d) return null;
  return Math.round((n / d) * 1000) / 10;
}

/** A score on its own at the end of a review ("84/100."), for when the model
 *  copied the review but not the score field. Only the final paragraph is
 *  read, so a "4/5 songs land" mid-review is never taken as the verdict. */
function scoreFromReviewEnd(review) {
  if (!review) return null;
  const tail = review.split('\n\n').pop() || '';
  return tail.length <= 40 ? parseScoreText(tail) : null;
}

/** 0-100 → nearest half-star, 0.5 floor. Same rule as show-score-proxy's
 *  scoreToRating, so an 84 imports as 4 stars from either source. */
export function scoreToRating(score) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) return null;
  return Math.max(0.5, Math.min(5, Math.round((score / 20) * 2) / 2));
}

/** "MM-DD" that exists in a leap year (so 02-29 passes; the year is decided
 *  later, client-side). */
function isMonthDay(s) {
  if (typeof s !== 'string' || !/^\d{2}-\d{2}$/.test(s)) return false;
  return isIsoDate(`2024-${s}`);
}

const SCREENS = new Set(['activity', 'collection', 'other']);
const REACTIONS = new Set(['recommend', 'mixed', 'dislike']);
const MAX_REVIEW_LEN = 10000;

/**
 * Clean the model's extraction into client-ready rows, in screenshot order.
 * - drops rows with no readable title or an unknown list
 * - nulls dates that aren't real calendar dates, predate 1900, or sit more
 *   than two years out (a misread year must not file a show into 2099)
 * - Interested rows keep their feed position (monthDay/yearHint, which the
 *   client's year walk needs) but never a date, score or review
 * - parses the user's own written score into 0-100 and a half-star rating
 *
 * Merging repeats is the client's job (mergeTheatrRows on web and iOS): it
 * has to run after the client resolves feed years across every screenshot.
 *
 * @param {unknown} extraction  parsed structured output
 * @param {string} today        YYYY-MM-DD, injected for testability
 */
export function normalizeExtraction(extraction, today) {
  const rows = extraction && typeof extraction === 'object' && Array.isArray(/** @type {any} */ (extraction).entries)
    ? /** @type {any} */ (extraction).entries
    : [];
  const maxYear = Number(today.slice(0, 4)) + 2;
  const okYear = (y) => Number.isInteger(y) && y >= 1900 && y <= maxYear;
  const entries = [];
  let dropped = 0;
  for (const row of rows) {
    const title = cleanText(row?.title, MAX_TITLE_LEN);
    const list = row?.list === 'attended' || row?.list === 'interested' ? row.list : null;
    if (!title || !list) { dropped++; continue; }
    const attended = list === 'attended';
    let date = isIsoDate(row?.date) ? row.date : null;
    if (date && !okYear(Number(date.slice(0, 4)))) date = null;
    const monthDay = isMonthDay(row?.month_day) ? row.month_day : null;
    const yearHint = okYear(row?.year_hint) ? row.year_hint : null;
    const review = attended ? cleanParagraphs(row?.review, MAX_REVIEW_LEN) : null;
    const score = attended ? (parseScoreText(row?.score_text) ?? scoreFromReviewEnd(review)) : null;
    entries.push({
      title,
      venue: cleanText(row?.venue, MAX_VENUE_LEN),
      list,
      screen: SCREENS.has(row?.screen) ? row.screen : 'other',
      // Interested rows are plans, not viewings: never a date seen.
      date: attended ? date : null,
      monthDay,
      yearHint,
      score,
      rating: scoreToRating(score),
      review,
      // A review the model saw only part of. Never imported (partial text
      // would be the user's words with holes), but counted so the preview can
      // say so and how to get it: overlapping screenshots.
      reviewCutOff: attended && !review && row?.review_cut_off === true,
      reaction: attended && REACTIONS.has(row?.reaction) ? row.reaction : null,
    });
  }
  return { entries, dropped };
}
