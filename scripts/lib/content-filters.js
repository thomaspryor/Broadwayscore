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
 * Check if a review URL clearly belongs to a different show.
 * Returns the detected wrong show slug if found, or null if URL is ok.
 *
 * Checks if URL path contains another show's slug as a distinct word-boundary
 * segment (e.g., "bug-broadway-review" matches "bug" but "debugging" does not).
 */
function urlBelongsToDifferentShow(url, targetShowId, targetSlug, shows) {
  if (!url) return null;

  let urlPath;
  try {
    urlPath = new URL(url).pathname.toLowerCase();
  } catch (e) {
    return null;
  }

  const pathSlug = urlPath
    .replace(/^\//, '')
    .replace(/\.(html?|php|asp)$/i, '');

  for (const show of shows) {
    if (show.id === targetShowId) continue;
    if (!show.slug || show.slug.length < 3) continue;

    const slug = show.slug.toLowerCase();
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const slugPattern = new RegExp('(?:^|[/-])' + escaped + '(?:$|[/-])', 'i');

    if (slugPattern.test(pathSlug)) {
      // Check if target show's slug (or base slug without year suffix) appears in URL
      const targetEscaped = targetSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const targetPattern = new RegExp('(?:^|[/-])' + targetEscaped + '(?:$|[/-])', 'i');
      if (targetPattern.test(pathSlug)) continue;

      // Also check base slug without trailing year (e.g., "cabaret-2024" → "cabaret")
      const baseSlug = targetSlug.replace(/-(?:19|20)\d{2}$/, '');
      if (baseSlug !== targetSlug && baseSlug.length >= 3) {
        const baseEscaped = baseSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const basePattern = new RegExp('(?:^|[/-])' + baseEscaped + '(?:$|[/-])', 'i');
        if (basePattern.test(pathSlug)) continue;
      }

      return show.slug;
    }
  }

  return null;
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

module.exports = { isNotBroadway, urlBelongsToDifferentShow, isUrlYearOutsideWindow };
