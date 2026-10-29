/**
 * Local (non-transfer) shows, e.g. Chicago productions from theatreinchicago.com
 * (BRO-6518). Stored as category/market 'regional' so score and review code is
 * shared, but withheld from every cross-market surface: homepage, the
 * Pre-Broadway shelf and browse page, Broadway/West End browse, search, related
 * shows of other markets and the iOS app feeds. They appear only on their own
 * show pages and the city hub (/tours/<city>).
 *
 * Mirror: scripts/lib/local-market.js (tests/unit/local-market.test.ts pins parity).
 */

/** discoverySource values that mark a show as local-only even without the field. */
export const LOCAL_DISCOVERY_SOURCES = ['theatreinchicago'];

export function isLocalOnlyShow(
  show: { localOnly?: boolean; discoverySource?: string } | null | undefined,
): boolean {
  if (!show) return false;
  return show.localOnly === true || (!!show.discoverySource && LOCAL_DISCOVERY_SOURCES.includes(show.discoverySource));
}
