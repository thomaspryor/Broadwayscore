/**
 * Show Score member-profile parser — pure functions, no I/O, no runtime APIs.
 *
 * Runs in two places: the show-score-proxy Deno edge function (index.ts) and
 * the node:test suite (tests/unit/show-score-profile-parser.test.mjs). Keep it
 * dependency-free and side-effect-free so both runtimes can import it.
 *
 * Profile pages (show-score.com/member/{slug}, ~50 reviews/page via ?page=N)
 * are server-rendered; each review is a <review-show-summary> element carrying
 * its data as HTML attributes. Attribute names are camelCase in the raw HTML
 * (reviewId, showtimeDate) but lowercased by the browser DOM — match
 * case-insensitively. Attribute values are HTML-entity-encoded.
 *
 * The mapping helpers return DOMAIN-READY ratings (0.5–5 half-star scale) so
 * the web client never has to import from this directory — the browser bundle
 * must not depend on supabase/functions/ (see plan review, design P1).
 */

const MARKET_HINTS = /^(broadway|west end|off[- ]broadway|off[- ]off[- ]broadway|national tour|touring?)$/i;

export function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Show Score displays stars = score/20 (verified: score 80 renders ★4 on the
 * live site). Snap to our half-star scale; DB CHECK requires 0.5–5, so floor
 * at 0.5. Unparseable scores return null — callers must surface the row as
 * "couldn't import", never silently clamp (pre-mortem: NaN corruption).
 * Same snap formula as src/lib/rating.ts sanitizeRating — kept as a separate
 * copy because this module must stay importable by Deno without reaching into
 * src/ (TS, different tree); if you change one, change both.
 */
export function scoreToRating(score) {
  const n = typeof score === 'string' ? parseFloat(score) : score;
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.max(0.5, Math.min(5, Math.round((n / 20) * 2) / 2));
}

/** "Broadway" / "West End" suffixes are market labels, not venues — they must
 *  not be passed to venue-aware show matching as if they named a theater. */
export function venueHintIsMarket(hint) {
  return MARKET_HINTS.test(String(hint || '').trim());
}

/** Strip production-year decorations Show Score appends to venue hints,
 *  e.g. "Minetta Lane Theatre | 2024 Production", "Public Theater 2023". */
export function cleanVenueHint(hint) {
  if (!hint) return null;
  const cleaned = String(hint)
    .replace(/\s*\|.*$/, '')
    .replace(/\s+\d{4}(\s+production)?\s*$/i, '')
    .trim();
  return cleaned || null;
}

/** Split 'Title (Venue-or-Market)' — the parenthetical suffix is optional. */
function splitShowTitle(raw) {
  const m = String(raw).match(/^(.*?)(?:\s*\(([^)]+)\))?\s*$/);
  return { title: m[1].trim(), venueHint: m[2] ? m[2].trim() : null };
}

/**
 * @typedef {Object} ProfileReview
 * @property {string|null} reviewId
 * @property {string} title
 * @property {string|null} venueHint
 * @property {number|null} rating
 * @property {number|null} sourceScore
 * @property {string|null} reviewText
 * @property {string|null} dateSeen
 */

/**
 * Parse all <review-show-summary> tiles from a profile page.
 * Returns domain-ready entries; rows whose score can't be parsed carry
 * rating: null and are counted by the caller as unparsed.
 * @param {string} html
 * @returns {{displayName: string|null, totalOnProfile: number|null, reviews: ProfileReview[]}}
 */
export function parseProfileHtml(html) {
  /** @type {{displayName: string|null, totalOnProfile: number|null, reviews: ProfileReview[]}} */
  const out = { displayName: null, totalOnProfile: null, reviews: [] };
  if (!html || typeof html !== 'string') return out;

  const titleTag = html.match(/<title>\s*Show Score\s*\|\s*([^<]+)<\/title>/i);
  if (titleTag) out.displayName = decodeEntities(titleTag[1].trim());

  const sectionCount = html.match(/>\s*(\d+)\s+Reviews?\s*</i);
  if (sectionCount) out.totalOnProfile = parseInt(sectionCount[1], 10);

  for (const m of html.matchAll(/<review-show-summary\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      attrs[a[1].toLowerCase()] = decodeEntities(a[2]);
    }
    if (!attrs.showtitle) continue;
    const { title, venueHint } = splitShowTitle(attrs.showtitle);
    if (!title) continue;
    out.reviews.push({
      reviewId: attrs.reviewid || null,
      title,
      venueHint,
      rating: scoreToRating(attrs.score),
      sourceScore: Number.isFinite(parseFloat(attrs.score)) ? parseFloat(attrs.score) : null,
      reviewText: attrs.comment || null,
      dateSeen: /^\d{4}-\d{2}-\d{2}$/.test(attrs.showtimedate || '') ? attrs.showtimedate : null,
    });
  }
  return out;
}

/** Highest ?page=N in the profile's pagination links (1 when unpaginated). */
export function parsePageCount(html) {
  let max = 1;
  for (const m of String(html || '').matchAll(/href="[^"]*\?page=(\d+)[^"]*"/gi)) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}
