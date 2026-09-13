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
 * CATEGORY_SUFFIX (e.g. 'broadway') returns the bare base slug unchanged.
 */
function withMarketSuffix(baseSlug, category) {
  const stripped = stripMarketSuffix(baseSlug);
  const suffix = CATEGORY_SUFFIX[category];
  return suffix ? `${stripped}-${suffix}` : stripped;
}

module.exports = { stripMarketSuffix, withMarketSuffix, MARKET_SUFFIXES };
