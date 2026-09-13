/**
 * Idempotent market-suffix slug/id builder.
 *
 * BRO-3237: two independent show-write paths (discover-new-shows.js,
 * promote-we-aggregator-candidates.js) each concatenated a market suffix
 * (`-west-end`, `-off-west-end`, `-off-broadway`) onto a base slug without
 * checking whether the slug already ended in one — producing doubled IDs
 * like `beetlejuice-the-musical-west-end-west-end-2026` whenever the input
 * slug/title had round-tripped through another discovery path. One shared,
 * tested helper closes the whole class instead of patching each site.
 */

const MARKET_SUFFIXES = ['off-west-end', 'west-end', 'off-broadway'];
const STRIP_RE = new RegExp(`-(?:${MARKET_SUFFIXES.join('|')})$`);

const CATEGORY_SUFFIX = {
  'west-end': 'west-end',
  'off-west-end': 'off-west-end',
  'off-broadway': 'off-broadway',
};

/** Strip any existing trailing market suffix from a slug. */
function stripMarketSuffix(slug) {
  return slug.replace(STRIP_RE, '');
}

/**
 * Build a market-suffixed slug, idempotently. `category` with no entry in
 * CATEGORY_SUFFIX (e.g. 'broadway', or undefined) returns `baseSlug`
 * completely untouched — no stripping — matching the pre-fix behavior for
 * those categories. Stripping must only ever happen on the branch that is
 * about to re-append a suffix; otherwise a Broadway show whose own title
 * happens to end in "West End" or "Off Broadway" would get silently
 * truncated, which is the same class of corruption this fix closes, just
 * inverted (caught in review, BRO-3237).
 */
function withMarketSuffix(baseSlug, category) {
  const suffix = CATEGORY_SUFFIX[category];
  if (!suffix) return baseSlug;
  return `${stripMarketSuffix(baseSlug)}-${suffix}`;
}

module.exports = { stripMarketSuffix, withMarketSuffix, MARKET_SUFFIXES };
