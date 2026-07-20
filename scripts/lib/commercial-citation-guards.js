/**
 * Citation-quality guards for commercial.json's recoupment claims.
 *
 * Extracted from audit-commercial-data.js (2026-07-20) after an independent
 * audit found two live recoupment claims with unverifiable citations that
 * had never been caught by --strict:
 *   - hadestown: recoupedSource was the plain text "Broadway News / Playbill"
 *     (no URL) and sources[] was empty. isUnsourcedRecouped() only checked
 *     that recoupedSource was truthy, so any non-empty string — even one
 *     with no URL, unclickable and unverifiable by a reader — counted as
 *     "sourced".
 *   - moulin-rouge: recoupedSource WAS a URL, but pointed to a closing
 *     announcement, not a recoupment article. A URL-presence check can
 *     never catch this class (the citation exists, it just doesn't support
 *     the claim) — that needs a content-level check, out of scope here.
 *
 * This module closes the first (structural) gap: a citation only counts as
 * real if it's independently checkable, i.e. an actual URL.
 */

const URL_REGEX = /^https?:\/\/\S+$/;

/** True when a string is a well-formed http(s) URL — not just non-empty text. */
function isRealUrl(value) {
  return typeof value === 'string' && URL_REGEX.test(value.trim());
}

/**
 * True when an entry claims recouped=true but has no independently
 * checkable citation: recoupedSource isn't a URL, and no sources[] entry
 * has a real URL either.
 *
 * Note: this only verifies a citation EXISTS and is checkable, not that its
 * content actually supports the claim (see moulin-rouge case above) — that
 * requires fetching and reading the page, which is a separate, more
 * expensive check (see verify-commercial-citations.js).
 */
function isUnsourcedRecouped(data) {
  if (!data || data.recouped !== true) return false;
  if (isRealUrl(data.recoupedSource)) return false;
  const hasUrlSource = Array.isArray(data.sources) &&
    data.sources.some(s => s && isRealUrl(s.url));
  return !hasUrlSource;
}

module.exports = {
  isRealUrl,
  isUnsourcedRecouped,
};
