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

/**
 * Clean the model's extraction into client-ready entries.
 * - drops rows with no readable title or an unknown list
 * - nulls dates that aren't real calendar dates, predate 1900, or sit more
 *   than two years out (a misread year must not file a show into 2099)
 * - dedupes rows repeated across overlapping screenshots (same list, title
 *   and date), keeping the first and filling a missing venue from the
 *   repeat; an undated Attended row folds into a dated one for the same title
 *   (its date was cropped off). Same rule as mergeTheatrRows on web
 *   (src/lib/show-import.ts) and in the iOS app (lib/theatr-import.ts).
 *
 * @param {unknown} extraction  parsed structured output
 * @param {string} today        YYYY-MM-DD, injected for testability
 * @returns {{ entries: { title: string, venue: string|null, date: string|null, list: 'attended'|'interested' }[], dropped: number }}
 */
export function normalizeExtraction(extraction, today) {
  const rows = extraction && typeof extraction === 'object' && Array.isArray(/** @type {any} */ (extraction).entries)
    ? /** @type {any} */ (extraction).entries
    : [];
  const maxYear = Number(today.slice(0, 4)) + 2;
  const cleaned = [];
  let dropped = 0;
  for (const row of rows) {
    const title = cleanText(row?.title, MAX_TITLE_LEN);
    const list = row?.list === 'attended' || row?.list === 'interested' ? row.list : null;
    if (!title || !list) { dropped++; continue; }
    let date = isIsoDate(row?.date) ? row.date : null;
    if (date) {
      const year = Number(date.slice(0, 4));
      if (year < 1900 || year > maxYear) date = null;
    }
    // Interested rows are plans, not viewings: a date there is at most a
    // planned date, and Theatr doesn't show one, so anything read is noise.
    if (list === 'interested') date = null;
    cleaned.push({ title, venue: cleanText(row?.venue, MAX_VENUE_LEN), date, list });
  }
  return { entries: mergeTheatrRows(cleaned), dropped };
}

/**
 * One row per list + title + date in first-seen order; an undated Attended
 * row folds into a dated row for the same title.
 * @param {{ title: string, venue: string|null, date: string|null, list: string }[]} rows
 */
export function mergeTheatrRows(rows) {
  const out = [];
  const byKey = new Map();
  const titleKey = (r) => `${r.list}|${r.title.toLowerCase()}`;
  const datedTitles = new Set(rows.filter((r) => r.list === 'attended' && r.date).map(titleKey));
  for (const r of rows) {
    const undatedDup = r.list === 'attended' && !r.date && datedTitles.has(titleKey(r));
    const key = undatedDup ? null : `${titleKey(r)}|${r.date || ''}`;
    const prev = key ? byKey.get(key) : out.find((o) => titleKey(o) === titleKey(r) && o.date);
    if (prev) {
      if (!prev.venue && r.venue) prev.venue = r.venue;
      continue;
    }
    if (!key) continue; // the dated copy comes later and carries this row
    const copy = { ...r };
    byKey.set(key, copy);
    out.push(copy);
  }
  return out;
}
