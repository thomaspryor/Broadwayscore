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

module.exports = { isNotBroadway, isUrlYearOutsideWindow };
