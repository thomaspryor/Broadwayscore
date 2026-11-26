/**
 * Market utility functions — single source of truth for market properties.
 * No data imports — safe for client components.
 * For venue classification (requires data/west-end-venues.json), use venue-classification.ts.
 */

import {
  MIN_REVIEWS_FOR_SCORE,
  MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY,
  MIN_REVIEWS_FOR_SCORE_WEST_END,
  MIN_REVIEWS_FOR_SCORE_OFF_WEST_END,
} from '@/config/score-buckets';

// A `category: 'regional'` show can be a US Broadway-feeder (A.R.T., Goodman,
// La Jolla) OR a UK West End-feeder (RSC Stratford, Chichester Festival
// Theatre — added for card #1405, Game of Thrones: The Mad King). The
// category alone can't tell them apart, so country/currency defaulted every
// regional show to 'US'/$ until now — silently wrong for any UK one.
// data/uk-regional-venues.json is the SAME list scripts/lib/aggregator-
// candidate-extract.js's REGIONAL_FEEDER_VENUES draws its UK entries from
// (via the `match` string, word-bounded there) — one source of truth, so
// adding a venue there automatically fixes currency/country here too.
// A plain JSON import is safe in a client bundle: venue-classification.ts's
// isOffWestEndVenue() already does exactly this with west-end-venues.json.
import ukRegionalVenues from '../../data/uk-regional-venues.json';
// Australian regional houses (BRO-8389 pilot). Same shape as the UK table; the AU seam is
// getRegionalCountry() below, so a future full Australia market only adds a category row.
import auRegionalVenues from '../../data/au-regional-venues.json';

export type ShowCategory = 'broadway' | 'off-broadway' | 'west-end' | 'off-west-end' | 'regional' | 'tour';

/** Returns true for both 'west-end' and 'off-west-end' — i.e., any London market. */
export function isLondonMarket(category?: string): boolean {
  return category === 'west-end' || category === 'off-west-end';
}

/**
 * Whether a London show page's <title> and OG/Twitter titles add "London" after the
 * show name (BRO-8085). UK searchers type "[show] london reviews" / "[show] west end
 * review", and a West End production with a Broadway twin ("Hamilton Reviews: Rave
 * 90/100") otherwise shares its Broadway page's title, so Google shows the Broadway
 * one. Same idea as tours adding "National Tour". False outside London and for titles
 * that already name London or the West End. Opera is the caller's call (its titles
 * carry the opera house instead).
 */
export function londonTitleNeedsSuffix(title: string, category?: string): boolean {
  if (!isLondonMarket(category)) return false;
  return !/\blondon\b|\bwest[\s-]*end\b/i.test(title);
}

/** Returns true for off-broadway and off-west-end — smaller venue markets. */
export function isOffMarket(category?: string): boolean {
  return category === 'off-broadway' || category === 'off-west-end';
}

/**
 * Whether a production has actually reached its stage — previews counts as
 * arrived. Used for regional→Broadway transfer tense (a tryout has
 * "transferred" only once the Broadway run exists; before that it is
 * "transferring"). Single source for the browse sectionGroup, its sort, and
 * the show-page trust line so the tense can never disagree between surfaces.
 */
export function hasReachedStage(status?: string | null): boolean {
  return status === 'previews' || status === 'open' || status === 'closed';
}

/**
 * Base minimum-reviews threshold for a market. Delegates to the canonical
 * MIN_REVIEWS_FOR_SCORE_* constants in score-buckets.ts so this never drifts
 * from the live list/show-page gate (West End = 5, Off-West End / Off-Broadway /
 * Regional = 3, Broadway = 5). Note: this is the BASE threshold only — the
 * T3-only and curated-historical adjustments live in
 * score-buckets.reviewsRemainingForScore().
 */
export function getMarketMinReviews(category?: string): number {
  switch (category) {
    case 'off-broadway':
    case 'off-off-broadway':
    case 'regional':
    case 'tour':
      return MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY;
    case 'off-west-end':
      return MIN_REVIEWS_FOR_SCORE_OFF_WEST_END;
    case 'west-end':
      return MIN_REVIEWS_FOR_SCORE_WEST_END;
    default:
      return MIN_REVIEWS_FOR_SCORE;
  }
}

type UkRegionalVenueEntry = { match: string; city: string; aliases?: string[] };

// A hand-entered venue ("Sheffield Crucible", "Royal Exchange Manchester") may
// carry an alias instead of the canonical `match` string; the pipeline accepts
// both, so the site must too or the show lands on the Pre-Broadway shelf.
function findUkRegionalVenue(category?: string, venue?: string): UkRegionalVenueEntry | undefined {
  if (category !== 'regional' || !venue) return undefined;
  const v = venue.toLowerCase();
  return (ukRegionalVenues as UkRegionalVenueEntry[]).find(
    (entry) => v.includes(entry.match) || (entry.aliases ?? []).some((alias) => v.includes(alias)),
  );
}

function isUkRegionalVenue(category?: string, venue?: string): boolean {
  return findUkRegionalVenue(category, venue) !== undefined;
}

/** Country a `regional` show belongs to. US is the default (Broadway feeders). */
export type RegionalCountry = 'US' | 'UK' | 'AU';

type AuRegionalVenueEntry = { match: string; city: string; aliases?: string[] };

// A venue string that ends in an Australian state/territory or "Australia" is AU even if the
// house is not in the table. WA, SA and NT are left out on purpose: "Seattle, WA" and
// "Nashville, SA"-style US strings must never match.
const AU_VENUE_SUFFIX = /,\s*(?:NSW|VIC|QLD|TAS|ACT|Australia)\s*$/i;

function findAuRegionalVenue(category?: string, venue?: string): AuRegionalVenueEntry | undefined {
  if (category !== 'regional' || !venue) return undefined;
  const v = venue.toLowerCase();
  return (auRegionalVenues as AuRegionalVenueEntry[]).find(
    (entry) => v.includes(entry.match) || (entry.aliases ?? []).some((alias) => v.includes(alias)),
  );
}

/**
 * The ONE country seam for a `regional` show (BRO-8389). Everything that used to ask
 * "UK or else US" asks this instead, so Australia (pilot) and any later market are a
 * new branch here, not a new set of parallel predicates.
 */
export function getRegionalCountry(show: { category?: string; venue?: string }): RegionalCountry {
  if (show.category !== 'regional') return 'US';
  if (isUkRegionalVenue(show.category, show.venue)) return 'UK';
  if (findAuRegionalVenue(show.category, show.venue) || AU_VENUE_SUFFIX.test(show.venue || '')) return 'AU';
  return 'US';
}

/**
 * A `regional` show at a UK flagship house (RSC, Chichester, ...). These are not
 * Broadway-bound tryouts, so they stay off the Pre-Broadway shelf and page and
 * surface under "Beyond London" on the West End page instead (BRO-5103).
 */
export function isUkRegionalShow(show: { category?: string; venue?: string }): boolean {
  return isUkRegionalVenue(show.category, show.venue);
}

/** A `regional` show at an Australian house (Sydney/Melbourne/Brisbane...). Not a Broadway tryout (BRO-8389). */
export function isAuRegionalShow(show: { category?: string; venue?: string }): boolean {
  return getRegionalCountry(show) === 'AU';
}

/** A `regional` show that is a US tryout/feeder: neither UK nor AU. */
export function isUsRegionalShow(show: { category?: string; venue?: string }): boolean {
  return show.category === 'regional' && getRegionalCountry(show) === 'US';
}

/** Badge/alt-text wording for a regional show: UK flagship houses read "UK Regional", US tryouts "Regional" (BRO-5269). */
export function getRegionalLabel(show: { category?: string; venue?: string }): string {
  const c = getRegionalCountry(show);
  return c === 'UK' ? 'UK Regional' : c === 'AU' ? 'Australia' : 'Regional';
}

/** City for an Australian regional venue (e.g. 'Sydney'). Undefined otherwise. */
export function getAuRegionalVenueCity(category?: string, venue?: string): string | undefined {
  return findAuRegionalVenue(category, venue)?.city
    ?? (AU_VENUE_SUFFIX.test(venue || '') ? /,\s*([^,]+?),\s*[A-Za-z]+\s*$/.exec(venue || '')?.[1]?.trim() : undefined);
}

/** City for a UK-regional venue (e.g. 'Stratford-upon-Avon' for RSC), from data/uk-regional-venues.json. Undefined for non-UK-regional venues. */
export function getUkRegionalVenueCity(category?: string, venue?: string): string | undefined {
  return findUkRegionalVenue(category, venue)?.city;
}

/**
 * The town of a US venue: "Arena Stage, Washington, DC" -> "Washington". Takes a
 * two-letter state, "D.C." and a trailing ZIP; undefined when there is no state.
 */
export function getUsVenueCity(venue?: string): string | undefined {
  const m = /,\s*([^,]+?),\s*(?:[A-Z]{2}|D\.C\.)(?:\s+\d{5})?\s*$/.exec(venue || '');
  return m ? m[1].trim() : undefined;
}

/** Country code for a market category. `venue` disambiguates UK-regional shows. */
export function getMarketCountry(category?: string, venue?: string): 'US' | 'GB' | 'AU' {
  if (isLondonMarket(category)) return 'GB';
  const c = getRegionalCountry({ category, venue });
  return c === 'UK' ? 'GB' : c;
}

/** Currency for a market category. `venue` disambiguates UK-regional shows. */
export function getMarketCurrency(category?: string, venue?: string): 'USD' | 'GBP' | 'AUD' {
  const country = getMarketCountry(category, venue);
  return country === 'GB' ? 'GBP' : country === 'AU' ? 'AUD' : 'USD';
}

/** Currency symbol for a market category. `venue` disambiguates UK-regional shows. */
export function getCurrencySymbol(category?: string, venue?: string): string {
  const country = getMarketCountry(category, venue);
  return country === 'GB' ? '£' : country === 'AU' ? 'A$' : '$';
}

/** Human-readable market label for a category. */
export function getMarketLabel(category?: string, venue?: string): string {
  switch (category) {
    case 'west-end': return 'West End';
    case 'off-west-end': return 'Off-West End';
    case 'off-broadway': return 'Off-Broadway';
    case 'regional': return getRegionalLabel({ category, venue });
    case 'tour': return 'Tour';
    default: return 'Broadway';
  }
}
