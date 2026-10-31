/**
 * Show genre/format policy — single source of truth for which non-play/musical
 * performance types are "non-theatrical" and therefore should NOT appear on the
 * West End / Broadway plays-and-musicals listings (they'd otherwise show up with
 * a critic score next to plays and musicals — category-error screenshot bait).
 *
 * Per product decision: dance, magic, comedy, cabaret, concert, and circus shows
 * KEEP their critic scores (critics do review them) but render only on the
 * Off-West End hub, labelled by genre. Opera is deliberately excluded here — it
 * has its own /opera route and isOperaShow() handling.
 *
 * The discovery-side classifier (scripts/lib/genre-classification.js) mirrors
 * NON_THEATRICAL_GENRES; tests/unit/genre-policy-parity.test.mjs fails if the two
 * lists drift. score-buckets-style boundary: this file is browser-safe (no node
 * deps) so client components can import it.
 */

/**
 * Genres that are performances rather than plays/musicals. A show carrying one of
 * these is routed to the Off-West End hub regardless of its venue-derived
 * category, and excluded from the West End plays/musicals listing.
 */
export const NON_THEATRICAL_GENRES = [
  'dance',
  'magic',
  'comedy',
  'cabaret',
  'concert',
  'circus',
] as const;

const NON_THEATRICAL_SET = new Set<string>(NON_THEATRICAL_GENRES);

/** True when a show's genre marks it as a non-play/musical performance. */
export function isNonTheatricalGenre(genre?: string | null): boolean {
  return !!genre && NON_THEATRICAL_SET.has(genre);
}

/** Minimal shape the London-hub routing predicates need. */
type LondonRoutable = { category?: string; genre?: string | null };

/** True for any London-market category (west-end or off-west-end). */
function isLondonCategory(category?: string): boolean {
  return category === 'west-end' || category === 'off-west-end';
}

/**
 * Pure per-show routing decisions for the two London hubs. data-core's
 * getWestEndShows() / getOffWestEndShows() map these over the catalog (plus a
 * HIDDEN_LONDON_IDS exclusion). Extracted here so the routing invariant is
 * unit-testable without loading the full data pipeline (see
 * tests/unit/london-hub-routing.test.ts).
 *
 * Invariants the two predicates jointly guarantee (tested):
 *  - A non-theatrical-genre show is NEVER on the West End listing.
 *  - A non-theatrical-genre London show is ALWAYS on the Off-West End hub.
 *  - Every London-category show is on at least one hub (none orphaned).
 *  - An Off-West End *theatrical* show is intentionally on BOTH (the /west-end
 *    page shows WE + OWE via a venue toggle); only the West End *listing* is
 *    genre-filtered.
 */
export function belongsOnWestEndListing(show: LondonRoutable): boolean {
  return isLondonCategory(show.category) && !isNonTheatricalGenre(show.genre);
}

export function belongsOnOffWestEndHub(show: LondonRoutable): boolean {
  return show.category === 'off-west-end' ||
    (isNonTheatricalGenre(show.genre) && isLondonCategory(show.category));
}
