/**
 * Canonical opera/market discriminator. SINGLE SOURCE OF TRUTH.
 *
 * Background: opera shows live in `data/shows.json` with `category: 'off-broadway'`
 * and `venue: 'Metropolitan Opera House'`. The `type: 'opera'` field discriminates
 * them from off-broadway plays/musicals. Historically that check was inlined in
 * engine.ts and data-core.ts; this module makes it canonical so future opera-aware
 * features (UI labels, market-specific copy, score weighting) ask one question.
 *
 * To extend to non-Met opera (NYCO, ENO, Glimmerglass etc.): widen `isOperaShow` to
 * also check venue, and the `OPERA_DURATION_SUFFIX` constant becomes per-venue.
 */
export type EffectiveMarket =
  | 'broadway'
  | 'off-broadway'
  | 'opera'
  | 'west-end'
  | 'off-west-end'
  | 'regional';

/** Subline suffix for opera shows, interpolated by getBroadwayDuration. */
export const OPERA_DURATION_SUFFIX = 'at the Met';

/** Market label shown in alt text and metadata. */
export const OPERA_MARKET_LABEL = 'Met Opera';

interface ShowLike {
  type?: string;
  category?: string;
}

/** Single source of truth: is this show an opera production? */
export function isOperaShow(show: ShowLike | null | undefined): boolean {
  if (!show) return false;
  return show.type === 'opera';
}

/**
 * Returns the effective market — collapses `(category='off-broadway' + type='opera')`
 * into the first-class market `'opera'`. Use this anywhere you need market-specific
 * UI copy, branding, or routing for an opera show.
 */
export function getEffectiveMarket(show: ShowLike | null | undefined): EffectiveMarket {
  if (isOperaShow(show)) return 'opera';
  const category = show?.category;
  if (category === 'west-end') return 'west-end';
  if (category === 'off-west-end') return 'off-west-end';
  if (category === 'off-broadway') return 'off-broadway';
  if (category === 'regional') return 'regional';
  return 'broadway';
}

/**
 * Human-readable market label for use in alt text, breadcrumbs, and meta tags.
 * Matches the spirit of `getMarketLabel(category)` in market-utils.ts but is
 * opera-aware.
 */
export function getEffectiveMarketLabel(show: ShowLike | null | undefined): string {
  switch (getEffectiveMarket(show)) {
    case 'opera':
      return OPERA_MARKET_LABEL;
    case 'west-end':
      return 'West End';
    case 'off-west-end':
      return 'Off-West End';
    case 'off-broadway':
      return 'Off-Broadway';
    case 'regional':
      return 'Regional';
    case 'broadway':
    default:
      return 'Broadway';
  }
}

/**
 * Duration-suffix override for the "3 months {suffix}" subline composed in
 * `getBroadwayDuration`. Returns 'at the Met' for opera, otherwise null
 * (caller falls back to the existing `getDurationSuffix(category)`).
 */
export function getOperaDurationSuffix(show: ShowLike | null | undefined): string | null {
  return isOperaShow(show) ? OPERA_DURATION_SUFFIX : null;
}
