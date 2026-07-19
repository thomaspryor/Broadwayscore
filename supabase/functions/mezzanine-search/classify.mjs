/**
 * Pure classification/slug/ranking helpers for mezzanine-search.
 *
 * This is a Deno-runtime ESM port of scripts/lib/mezzanine-classify.js and
 * the ranking half of src/lib/show-import.ts's tierSearchResults(). Edge
 * functions can't `require()` a CommonJS Node file, so classifyProduction /
 * slugify / buildStubId are duplicated here — keep in sync with
 * scripts/lib/mezzanine-classify.js (buildStubId MUST produce the same id as
 * buildDiarySlug() for the same title/category/mezzId, or a stub's id won't
 * match the diary-shows.json entry the nightly resolver promotes it to).
 */

/** Classify a Mezzanine Production by location/market. */
export function classifyProduction(p) {
  const theater = p.theater || {};
  if (theater.isBroadway === true) return 'broadway';

  const loc = (theater.location || '').toLowerCase();
  const city = (theater.geocodedCity || '').toLowerCase();
  const country = (theater.geocodedCountryCode || '').toUpperCase();

  if (loc === 'newyork' || loc === 'nyc' ||
      loc.includes('new york') || loc.includes('brooklyn') || loc.includes('manhattan') ||
      city === 'new york' || city === 'brooklyn' || city === 'manhattan') {
    return 'off-broadway';
  }
  if (loc === 'london' || city === 'london') return 'west-end';
  if (country === 'GB') return 'uk-regional';
  if (country === 'US') return 'us-regional';
  if (country) return 'international';
  return 'other';
}

/** Generate a URL-safe slug from a title. */
export function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

/** Deterministic stub/diary id — MUST match buildDiarySlug()'s output shape
 *  (mezzId is already globally unique, so no collision-avoidance needed here
 *  the way the resolver's usedSlugs set requires). */
export function buildStubId(title, category, mezzProdId) {
  const baseSlug = slugify(title) || 'show';
  return `${baseSlug}-${category}-mz${mezzProdId}`;
}

function parseDate(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.substring(0, 10);
  if (val.iso) return val.iso.substring(0, 10);
  return null;
}

/** Turn a raw Mezzanine Production (with show+theater included) into a
 *  ranked search candidate. Returns null for Broadway productions — those
 *  are added via a different pipeline and would never be drained by the
 *  resolver (productionToDiaryEntry also excludes them), so surfacing them
 *  here would create a permanently-undrained stub if selected. */
export function productionToCandidate(p) {
  const showName = (typeof p.show === 'object' ? p.show?.name : null) || null;
  if (!showName) return null;
  const category = classifyProduction(p);
  if (category === 'broadway') return null;

  const theater = typeof p.theater === 'object' ? p.theater : {};
  const mezzProdId = p.objectId;
  const mezzShowId = typeof p.show === 'object' ? p.show?.objectId : null;

  return {
    id: buildStubId(showName, category, mezzProdId),
    mezzShowId,
    mezzProdId,
    title: showName,
    venue: theater.name || null,
    city: theater.geocodedCity || null,
    country: theater.geocodedCountryCode || null,
    category,
    openingDate: parseDate(p.opened || p.firstPreview),
    posterUrl: p.art?.url || null,
    ratingsCount: p.ratingsCount || 0,
  };
}

// NYC/London first (matches tierSearchResults' NEAR_MARKET_CATEGORIES in
// src/lib/show-import.ts), then popularity, then recency — owner direction
// 2026-07-14 (card 39d637c5-416f-819b): a common near-market production
// must never get buried under a long tail of regional matches.
const NEAR_MARKET_CATEGORIES = new Set(['off-broadway', 'west-end']);

/** Sort candidates NYC/London -> popularity -> recency, then cap to `limit`. */
export function rankCandidates(candidates, limit = 10) {
  const ranked = [...candidates].sort((a, b) => {
    const marketDiff = Number(!NEAR_MARKET_CATEGORIES.has(a.category)) - Number(!NEAR_MARKET_CATEGORIES.has(b.category));
    if (marketDiff !== 0) return marketDiff;
    const popDiff = (b.ratingsCount || 0) - (a.ratingsCount || 0);
    if (popDiff !== 0) return popDiff;
    return (b.openingDate || '').localeCompare(a.openingDate || '');
  });
  // Mezzanine's user-generated catalog holds many literal duplicate records of
  // the same production (14 copies of one Players Theatre show, differing only
  // in venue casing — owner repro 2026-07-19). Collapse to one candidate per
  // normalized title+venue+year, keeping the best-ranked copy; distinct years
  // survive as separate candidates (real revivals).
  const seen = new Set();
  const deduped = [];
  for (const c of ranked) {
    // Leading "the" stripped from venue like ImportShows' vnorm — "Players
    // Theatre" and "The Players Theatre" are the same building. A candidate
    // without a title (shouldn't happen post-productionToCandidate) keys on
    // its own id so it can never collapse into another.
    const key = c.title
      ? `${normalizeQuery(c.title)}|${normalizeQuery(c.venue || '').replace(/^the /, '')}|${(c.openingDate || '').slice(0, 4)}`
      : `id:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped.slice(0, limit);
}

/** Normalize a search query the same way ImportShows.tsx's normTitle does
 *  (curly quotes/ampersand/punctuation) before it becomes a Mezzanine
 *  searchableName regex — mirrors ImportShows.tsx, kept in sync manually. */
export function normalizeQuery(q) {
  return q
    .toLowerCase()
    .replace(/[‘’‚′']/g, '')
    .replace(/[“”„″"]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
