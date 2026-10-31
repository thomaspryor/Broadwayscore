'use strict';

/**
 * Local (non-transfer) shows, e.g. Chicago productions from theatreinchicago.com
 * (BRO-6518). They live in shows.json as category/market 'regional' so score,
 * review and show-page code works unchanged, but they must NOT appear on the
 * homepage, the Pre-Broadway shelf (/browse/pre-broadway-out-of-town-shows),
 * Broadway / West End browse pages, search, or the iOS app feeds. They show
 * only on their own show pages and the city hub (/tours/<city>).
 *
 * Mirror: src/lib/local-market.ts (tests/unit/local-market.test.ts pins parity).
 */

/** discoverySource values that mark a show as local-only even without the field. */
const LOCAL_DISCOVERY_SOURCES = ['theatreinchicago'];

function isLocalOnlyShow(show) {
  if (!show) return false;
  return show.localOnly === true || LOCAL_DISCOVERY_SOURCES.includes(show.discoverySource);
}

module.exports = { isLocalOnlyShow, LOCAL_DISCOVERY_SOURCES };
