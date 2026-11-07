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
import { isUkRegionalShow } from '@/lib/market-utils';

export type EffectiveMarket =
  | 'broadway'
  | 'off-broadway'
  | 'opera'
  | 'west-end'
  | 'off-west-end'
  | 'regional'
  | 'uk-regional'
  | 'tour';

/** Subline suffix for opera shows, interpolated by getBroadwayDuration. */
export const OPERA_DURATION_SUFFIX = 'at the Met';

/** Market label shown in alt text and metadata. */
export const OPERA_MARKET_LABEL = 'Met Opera';

/** Royal Opera House (Covent Garden) labels, BRO-6766. */
export const ROH_MARKET_LABEL = 'Royal Opera House';
export const ROH_DURATION_SUFFIX = 'at the Royal Opera House';

/** True when an opera venue is the Royal Opera House / Royal Ballet and Opera. */
export function isRoyalOperaVenue(venue: string | null | undefined): boolean {
  return !!venue && /royal (ballet and )?opera|covent garden/i.test(venue);
}

/** Non-Met houses tracked for new productions and premieres (BRO-6782). */
export const SFO_MARKET_LABEL = 'San Francisco Opera';
export const SFO_DURATION_SUFFIX = 'at San Francisco Opera';
export const ENO_MARKET_LABEL = 'English National Opera';
export const ENO_DURATION_SUFFIX = 'at English National Opera';

export function isSanFranciscoOperaVenue(venue: string | null | undefined): boolean {
  return !!venue && /war memorial opera house|san francisco opera/i.test(venue);
}

export function isEnglishNationalOperaVenue(venue: string | null | undefined): boolean {
  return !!venue && /london coliseum|english national opera/i.test(venue);
}

/** House-aware market label for an opera show ("Met Opera", "Royal Opera House", ...). */
export function getOperaMarketLabel(show: { venue?: string } | null | undefined): string {
  const v = show?.venue;
  if (isRoyalOperaVenue(v)) return ROH_MARKET_LABEL;
  if (isSanFranciscoOperaVenue(v)) return SFO_MARKET_LABEL;
  if (isEnglishNationalOperaVenue(v)) return ENO_MARKET_LABEL;
  return OPERA_MARKET_LABEL;
}


interface ShowLike {
  type?: string;
  category?: string;
  venue?: string;
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
  if (show && isUkRegionalShow(show)) return 'uk-regional';
  const category = show?.category;
  if (category === 'west-end') return 'west-end';
  if (category === 'off-west-end') return 'off-west-end';
  if (category === 'off-broadway') return 'off-broadway';
  if (category === 'regional') return 'regional';
  if (category === 'tour') return 'tour';
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
      return getOperaMarketLabel(show);
    case 'west-end':
      return 'West End';
    case 'off-west-end':
      return 'Off-West End';
    case 'off-broadway':
      return 'Off-Broadway';
    case 'regional':
      return 'Regional';
    case 'uk-regional':
      return 'UK Regional';
    case 'tour':
      return 'Tour';
    case 'broadway':
    default:
      return 'Broadway';
  }
}

/**
 * Duration-suffix override for the "3 months {suffix}" subline composed in
 * `getBroadwayDuration`. Returns 'at the Met' (or 'at the Royal Opera House' for ROH) for opera, otherwise null
 * (caller falls back to the existing `getDurationSuffix(category)`).
 */
export function getOperaDurationSuffix(show: ShowLike | null | undefined): string | null {
  return isOperaShow(show) ? getOperaHouseSuffix(show) : null;
}

/** Non-null house-aware suffix for callers that already know the show is an opera. */
export function getOperaHouseSuffix(show: { venue?: string } | null | undefined): string {
  const v = show?.venue;
  if (isRoyalOperaVenue(v)) return ROH_DURATION_SUFFIX;
  if (isSanFranciscoOperaVenue(v)) return SFO_DURATION_SUFFIX;
  if (isEnglishNationalOperaVenue(v)) return ENO_DURATION_SUFFIX;
  return OPERA_DURATION_SUFFIX;
}
