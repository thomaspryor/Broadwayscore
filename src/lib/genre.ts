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
