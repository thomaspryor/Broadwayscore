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
 * real if it's independently checkable, i.e. an actual URL. It deliberately
 * does NOT reuse scripts/lib/commercial-sources.js's normalizeSource() —
 * that module's job is coercing writer output into a validator-compatible
 * *shape* (type/date), not judging whether a URL is checkable. Different
 * concern, different lib; if they drift apart, that's a signal to merge them,
 * not evidence one is wrong.
 */

// Matches an http(s) URL either as the entire string, or as a clickable
// prefix followed by explanatory prose in parens/dash (e.g. the citations
// this session wrote: "https://... (Broadway News, citing SEC filing...)").
// Requiring an exact full-string match would reject that second, very common
// shape even though the URL itself is perfectly real and clickable.
const URL_REGEX = /^(https?:\/\/\S+?)(?:\s|$)/;

/** True when a string contains a well-formed, extractable http(s) URL. */
function isRealUrl(value) {
  if (typeof value !== 'string') return false;
  return URL_REGEX.test(value.trim());
}

/**
 * Explicit, documented exceptions to isUnsourcedRecouped — for claims that
 * are true but structurally can never have a checkable citation (e.g. a
 * publisher that never issues a formal recoupment announcement), as opposed
 * to claims nobody has gotten around to re-sourcing yet. Every entry MUST
 * carry a human-readable reason; this is reviewed in code review same as any
 * other change, so it can't be used to silently paper over real gaps.
 *
 * Do NOT add an entry here just because a citation was hard to find (e.g.
 * pre-2010 shows predating the modern "recoups on Broadway" trade-press
 * ritual) — that's still fixable with more research, see card
 * 3a3637c5-416f-8116-9243-d0d25ce393bb. This allowlist is only for claims
 * where a citation is impossible in principle, not merely undiscovered.
 */
const UNSOURCEABLE_RECOUPMENT_EXCEPTIONS = {
  aladdin: 'Disney does not issue formal Broadway recoupment announcements for its titles; recoupedDate is an industry-analysis estimate (grosses vs. cumulative costs), not a reported fact with a citable source.',
  'the-lion-king': 'Card 3a3637c5-416f-8116-9243-d0d25ce393bb (2026-07-28) did the "more research" this list demands before exempting a pre-2010 show: WebSearch/WebFetch across Playbill, Variety, Hollywood Reporter, Vanity Fair, Forbes, CBS News, financingbroadway.wordpress.com\'s compiled recoup-history table, and site-restricted searches of playbill.com and broadwaynews.com — plus checking Wikipedia\'s own citation for this claim, which Wikipedia itself flags "[according to whom?]" (i.e. Wikipedia considers it uncited too). The ~2-year recoupment timeframe is repeated everywhere as fact but traces to no dated, checkable primary article — this 1997 Disney production predates both the modern "X Recoups on Broadway" trade-press ritual (established practice from the 2000s on, see wicked/book-of-mormon/six citations in this file\'s history) and most outlets\' searchable online archives. Disney also does not issue formal recoupment announcements (see aladdin, above). Revisit only if a NYT TimesMachine, Variety archive, or ProQuest subscription becomes available to search 1998-99 press.',
  chicago: 'Same research pass and same conclusion as the-lion-king (see that entry) for this 1996 revival: Playbill/Variety/NYT web search, financingbroadway.wordpress.com, and site-restricted playbill.com/broadwaynews.com searches all came up empty. "Recouped faster than any other musical in history" is repeated across New York Theatre Guide, IBDB, and Wikipedia — Wikipedia flags its own copy of this exact sentence "[according to whom?]" — but none of them cite a dated, checkable primary source. Predates the modern recoupment-announcement ritual and most outlets\' searchable archives. Revisit only if a NYT TimesMachine, Variety archive, or ProQuest subscription becomes available to search 1996-97 press.',
};

/**
 * True when an entry claims recouped=true but has no independently
 * checkable citation: recoupedSource isn't a URL, no sources[] entry has a
 * real URL, and the show isn't in UNSOURCEABLE_RECOUPMENT_EXCEPTIONS.
 *
 * Note: this only verifies a citation EXISTS and is checkable, not that its
 * content actually supports the claim (see moulin-rouge case above) — that
 * requires fetching and reading the page, which is a separate, more
 * expensive check (see verify-commercial-citations.js).
 */
function isUnsourcedRecouped(data, key) {
  if (!data || data.recouped !== true) return false;
  if (key && UNSOURCEABLE_RECOUPMENT_EXCEPTIONS[key]) return false;
  if (isRealUrl(data.recoupedSource)) return false;
  const hasUrlSource = Array.isArray(data.sources) &&
    data.sources.some(s => s && isRealUrl(s.url));
  return !hasUrlSource;
}

module.exports = {
  isRealUrl,
  isUnsourcedRecouped,
  UNSOURCEABLE_RECOUPMENT_EXCEPTIONS,
};
