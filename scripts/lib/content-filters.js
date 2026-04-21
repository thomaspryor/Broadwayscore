/**
 * Shared content filters for Broadway/non-Broadway classification.
 *
 * Single source of truth — imported by scrape-playbill-verdict.js,
 * scrape-bww-reviews.js, scrape-cast-changes.js, and any future scrapers.
 *
 * Superset of all patterns previously duplicated across 3 files.
 */

/**
 * Returns true if the text indicates non-Broadway content (tour, off-Broadway,
 * regional, film/TV, streaming, West End, etc.)
 *
 * @param {string} text - Title, outlet name, or article text to check
 * @param {Object} options - { allowOffBroadway: boolean, allowWestEnd: boolean }
 * @returns {boolean}
 */
function isNotBroadway(text, options = {}) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const { allowOffBroadway = false, allowWestEnd = false } = options;

  // Off-Broadway / regional — skip these checks if allowOffBroadway
  if (!allowOffBroadway) {
    if (lower.includes('off-broadway') ||
        lower.includes('off broadway') ||
        // Off-Broadway venues
        lower.includes('public theater') || lower.includes('at the public') ||
        // World premieres — many off-Broadway shows ARE world premieres
        lower.includes('world premiere')) {
      return true;
    }
  }

  // West End / London — skip these checks if allowWestEnd
  if (!allowWestEnd) {
    if (lower.includes('west end') ||
        lower.includes('london') ||
        // UK venues that could appear in review text
        lower.includes('playhouse theatre')) {
      return true;
    }
  }

  return (
    // Always rejected regardless of category
    lower.includes('opera') ||
    lower.includes('in chicago') ||
    // Touring
    lower.includes('national tour') ||
    lower.includes('north american tour') ||
    lower.includes('touring production') ||
    lower.includes('touring cast') ||
    lower.includes('touring company') ||
    // Film / movie
    lower.includes('film review') ||
    lower.includes('film adaptation') ||
    lower.includes('filmed version') ||
    lower.includes('movie') ||
    lower.includes('on film') ||
    lower.includes('on screen') ||
    // Regional venues (NOT off-Broadway NYC venues, NOT West End)
    lower.includes('chicago shakespeare') ||
    lower.includes('old globe') || lower.includes('la jolla') ||
    lower.includes('hollywood bowl') || lower.includes('at the ahmanson') ||
    // TV specials and streaming
    (lower.includes(' live') && (lower.includes('nbc') || lower.includes('tv') || lower.includes('fox'))) ||
    lower.includes('tv review') || lower.includes('tv series') || lower.includes('tv show') ||
    lower.includes('apple tv') || lower.includes('netflix') ||
    lower.includes('hulu') || lower.includes('disney+') ||
    lower.includes('streaming') || lower.includes('amazon prime')
  );
}

/**
 * Check if a URL's embedded year falls outside a production's date window.
 * Returns true if the URL year is clearly wrong (safe reject filter).
 *
 * Per CLAUDE.md §6, URL years are unreliable for positive matching
 * but safe as a reject filter.
 */
function isUrlYearOutsideWindow(url, openingYear, closingYear) {
  if (!url || !openingYear) return false;
  const m = url.match(/\/((?:19|20)\d{2})\//);
  if (!m) return false;
  const urlYear = parseInt(m[1]);
  // If show is still running (no closingYear), allow up to current year + 1
  const currentYear = new Date().getFullYear();
  const upper = closingYear
    ? Math.max(closingYear + 1, openingYear + 2)
    : currentYear + 1;
  return urlYear < openingYear - 3 || urlYear > upper;
}

/**
 * URL path markers indicating non-Broadway productions that share a show title.
 * These are safe hard-rejects at SERP discovery time — if ANY of these strings
 * appear in the URL (case-insensitive), the result is almost certainly a different
 * production (tryout, TV, film, world premiere).
 *
 * Confirmed incidents:
 *  - 2026-04-20 Schmigadoon opening: SERP returned Kennedy Center world-premiere
 *    roundup (2025) instead of Broadway; 9 T1/T2 URLs scraped for Kennedy Center
 *    tryout, 2021 Apple TV+ series, and an Off-Broadway Transfer.
 *
 * Used by:
 *  - scripts/lib/url-discovery.js (general SERP prefilter, all outlets)
 *  - scripts/lib/bww-roundup-validator.js (BWW RR slug validation)
 *  - scripts/collect-review-texts.js (via url-discovery)
 *
 * Do NOT add generic words like "review" — this list is strictly for URL
 * patterns that identify a DIFFERENT production of the same title.
 */
const TRYOUT_URL_MARKERS = [
  'world-premiere',
  'world_premiere',
  'kennedy-center',
  'kennedycenter',
  'pre-broadway',
  'prebroadway',
  'out-of-town',
  'tryout',
  'try-out',
  'tv-review',
  'tv_review',
  'television-review',
  'film-review',
  'film_review',
  'movie-review',
  'streaming-review',
  'netflix-review',
  'apple-tv',
  'appletv',
  'disney-plus',
  'la-jolla',
  'old-globe',
  'old_globe',
  'ahmanson',
  'geffen-playhouse',
  'national-tour',
  'tour-review',
  'on-tour',
];

/**
 * Returns true if the URL contains any tryout/TV/film/pre-Broadway marker.
 * Used as a SERP prefilter and BWW slug validator.
 *
 * @param {string} url - Full URL or URL slug
 * @returns {{ rejected: boolean, marker?: string }}
 */
function hasTryoutUrlMarker(url) {
  if (!url || typeof url !== 'string') return { rejected: false };
  const lower = url.toLowerCase();
  for (const marker of TRYOUT_URL_MARKERS) {
    if (lower.includes(marker)) {
      return { rejected: true, marker };
    }
  }
  return { rejected: false };
}

/**
 * Outlets known to publish "anticipation" / preview / feature pieces well
 * before opening night. For these outlets an ingest-time gate is tighter:
 * anything published before openingDate is rejected unless manually cleared
 * (humanReviewedEarlyPublish: true in the source review file).
 *
 * Confirmed incident:
 *  - 2026-04-20 Schmigadoon opening: frontmezzjunkies post published 2026-04-04
 *    (16 days pre-opening) got scored 76 and reached the review pool. Bug #5
 *    in the Schmigadoon 2026 postmortem.
 *
 * Do NOT add T1 news outlets here (NYT, Variety, etc.) — their embargo-lift
 * coverage is legitimately 48–72h pre-opening and the default 2-day grace
 * already accommodates it.
 */
const PREVIEW_HEAVY_OUTLETS = new Set([
  'frontmezzjunkies',
  'broadwaydirect',
  'broadway-direct',
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Default: allow publishDate up to 2 days before openingDate (matches the
 * post-broadcast audit check at scripts/lib/opening-night-checks/
 * publish-date-pre-opening.check.js). Press embargoes routinely lift 24–48h
 * early, so this grace is load-bearing for T1 outlets.
 */
const DEFAULT_GRACE_DAYS_BEFORE_OPENING = 2;

/**
 * Preview-heavy outlets publish pre-opening feature pieces that read like
 * reviews but aren't. For these outlets, require publishDate >= openingDate
 * (grace = 0). Override via opts.gracePreviewHeavyOutlet in tests.
 */
const PREVIEW_HEAVY_GRACE_DAYS = 0;

/**
 * Returns whether a review is an anticipatory pre-opening-night post that
 * should be rejected at ingest. Matches the semantics of the existing
 * post-broadcast audit check (publish-date-pre-opening.check.js) but fires
 * BEFORE the review reaches reviews.json / scoring.
 *
 * Bypass: opt-in via humanReviewedEarlyPublish=true on the source file.
 * Curators may intentionally clear anticipatory posts they've verified as
 * legitimate reviews (rare — typically only for T1 embargo-lift coverage).
 *
 * @param {string|null} publishDate - Review publish date (YYYY-MM-DD)
 * @param {string|null} openingDate - Show opening date (YYYY-MM-DD)
 * @param {string|null} outletId - Review outlet ID (normalized)
 * @param {Object} [opts]
 * @param {boolean} [opts.humanReviewedEarlyPublish] - Manual clear flag from source file
 * @param {number} [opts.graceDays] - Override default 2-day grace (non-preview outlets)
 * @param {number} [opts.gracePreviewHeavyOutlet] - Override 0-day grace for preview-heavy outlets
 * @returns {{ rejected: boolean, reason?: string, daysBeforeOpening?: number, outletCategory?: 'preview-heavy'|'default' }}
 */
function isAnticipatoryPreviewPost(publishDate, openingDate, outletId, opts = {}) {
  if (opts.humanReviewedEarlyPublish === true) {
    return { rejected: false };
  }
  if (!publishDate || !openingDate) {
    return { rejected: false };
  }

  const opening = new Date(openingDate);
  const publish = new Date(publishDate);
  if (Number.isNaN(opening.getTime()) || Number.isNaN(publish.getTime())) {
    return { rejected: false };
  }

  const isPreviewHeavy = !!(outletId && PREVIEW_HEAVY_OUTLETS.has(String(outletId).toLowerCase()));
  const graceDays = isPreviewHeavy
    ? (opts.gracePreviewHeavyOutlet != null ? opts.gracePreviewHeavyOutlet : PREVIEW_HEAVY_GRACE_DAYS)
    : (opts.graceDays != null ? opts.graceDays : DEFAULT_GRACE_DAYS_BEFORE_OPENING);

  const cutoff = new Date(opening.getTime() - graceDays * MS_PER_DAY);
  if (publish >= cutoff) {
    return { rejected: false };
  }

  const daysBeforeOpening = Math.round((opening.getTime() - publish.getTime()) / MS_PER_DAY);
  return {
    rejected: true,
    reason: isPreviewHeavy
      ? `preview-heavy outlet "${outletId}" published ${daysBeforeOpening}d before openingDate (${openingDate}); require publish on/after opening unless cleared`
      : `published ${daysBeforeOpening}d before openingDate (${openingDate}); exceeds ${graceDays}-day grace`,
    daysBeforeOpening,
    outletCategory: isPreviewHeavy ? 'preview-heavy' : 'default',
  };
}

module.exports = {
  isNotBroadway,
  isUrlYearOutsideWindow,
  TRYOUT_URL_MARKERS,
  hasTryoutUrlMarker,
  PREVIEW_HEAVY_OUTLETS,
  DEFAULT_GRACE_DAYS_BEFORE_OPENING,
  PREVIEW_HEAVY_GRACE_DAYS,
  isAnticipatoryPreviewPost,
};
