/**
 * Label for the show hero's watchlist toggle (BRO-3683).
 *
 * A running show the user has already rated must not offer a plain
 * "Want to See": the nightly UX walkthrough flagged that as an impossible
 * action next to the user's own rating. It offers "See it again" instead.
 * Closed shows keep "Want to See" ("wished I'd seen" semantics, see the
 * ShowHeroRedesign header comment).
 */
export type WatchlistCtaLabel = 'On your list' | 'See it again' | 'Want to See';

export function getWatchlistCtaLabel(state: {
  onWatchlist: boolean;
  hasRating: boolean;
  isClosed: boolean;
}): WatchlistCtaLabel {
  if (state.onWatchlist) return 'On your list';
  if (state.hasRating && !state.isClosed) return 'See it again';
  return 'Want to See';
}
