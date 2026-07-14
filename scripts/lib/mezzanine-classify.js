/**
 * Shared classification/slug helpers for turning a raw Mezzanine Production
 * into a diary-shows.json entry. Extracted from import-mezzanine-historical.js
 * so resolve-unmatched-imports.js and refresh-mezzanine-catalog.js don't fork
 * the location-classification logic (test-extraction rule 15).
 */

/** Classify a Mezzanine Production by location/market. */
function classifyProduction(p) {
  const theater = p.theater || {};

  // Skip Broadway — already in shows.json
  if (theater.isBroadway === true) return 'broadway';

  const loc = (theater.location || '').toLowerCase();
  const city = (theater.geocodedCity || '').toLowerCase();
  const country = (theater.geocodedCountryCode || '').toUpperCase();

  // NYC Off-Broadway
  if (loc === 'newyork' || loc === 'nyc' ||
      loc.includes('new york') || loc.includes('brooklyn') || loc.includes('manhattan') ||
      city === 'new york' || city === 'brooklyn' || city === 'manhattan') {
    return 'off-broadway';
  }

  // London / West End
  if (loc === 'london' || city === 'london') {
    return 'west-end';
  }

  // UK regional
  if (country === 'GB') return 'uk-regional';

  // US regional
  if (country === 'US') return 'us-regional';

  // International
  if (country) return 'international';

  // Unknown location — classify as 'other'
  return 'other';
}

/** Generate a URL-safe slug from a title. */
function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/['']/g, '')
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80); // cap length
}

/** Parse a date from Mezzanine's format (bare string or Parse Date object). */
function parseDate(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.substring(0, 10);
  if (val.iso) return val.iso.substring(0, 10);
  return null;
}

/**
 * Build a diary-shows.json entry from a raw Mezzanine Production (expects
 * `show` and `theater` pointers already resolved via `include`).
 * Returns null for Broadway productions — those belong in shows.json, not here.
 */
function productionToDiaryEntry(p) {
  const showName = (typeof p.show === 'object' ? p.show?.name : null) || p.showName;
  if (!showName) return null;

  const category = classifyProduction(p);
  if (category === 'broadway') return null;

  const opened = parseDate(p.opened || p.firstPreview);
  const theater = typeof p.theater === 'object' ? p.theater : {};
  const venue = theater.name || p.theaterName || '';
  const city = theater.geocodedCity || '';
  const country = theater.geocodedCountryCode || '';
  const mezzId = p.objectId;

  const audienceScore = p.averageRating
    ? Math.round((p.averageRating / 5) * 100)
    : null;

  const entry = {
    title: showName,
    venue,
    city,
    country,
    category,
    openingDate: opened,
    status: 'closed',
    audienceScore,
    audienceRatingsCount: p.ratingsCount || 0,
    mezzanineId: mezzId,
  };

  if (p.art && p.art.url) entry.posterUrl = p.art.url;

  return entry;
}

/**
 * Generate the id/slug for a diary entry, avoiding collisions with the given
 * sets of already-used slugs/ids. Card-specified pattern: <slug>-<category>-mz<prodObjectId>
 * (full objectId, not truncated — matches the hand-added entries from 2026-07-14).
 */
function buildDiarySlug(title, category, mezzId, usedSlugs) {
  let baseSlug = slugify(title) || 'show';
  let slug = `${baseSlug}-${category}-mz${mezzId}`;
  if (!usedSlugs.has(slug)) return slug;
  // Extremely unlikely (mezzId is already unique) — fall back defensively.
  let suffix = 2;
  while (usedSlugs.has(`${slug}-${suffix}`)) suffix++;
  return `${slug}-${suffix}`;
}

module.exports = { classifyProduction, slugify, parseDate, productionToDiaryEntry, buildDiarySlug };
