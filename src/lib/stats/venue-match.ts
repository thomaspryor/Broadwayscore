/**
 * Venue key normalization + diary→theater-metadata matching.
 *
 * `normalizeVenueKey` is the canonical normalizer EXTRACTED from
 * src/lib/venue-classification.ts (which now imports it). Its behavior is
 * frozen: lowercase, trim, strip a trailing parenthetical, strip a trailing
 * " theatre"/" theater". Changing it changes West End market routing, so any
 * looser normalization for diary matching lives in `normalizeForMatch` below.
 *
 * Pure: no I/O, no React. The only import is a static alias table (data).
 */

import aliasTable from './venue-aliases.json';

/**
 * Canonical venue normalizer — single source of truth.
 *
 * FROZEN BEHAVIOR: venue-classification.ts::isOffWestEndVenue matches the
 * result of this function against data/west-end-venues.json, so a change here
 * silently re-routes West End vs Off-West End markets. Add new normalization
 * to normalizeForMatch() instead.
 */
export function normalizeVenueKey(venue?: string | null): string {
  if (!venue) return '';
  return venue
    .trim()
    .toLowerCase()
    .replace(/\s*\(.*\)$/, '')
    .replace(/ theatre$| theater$/, '');
}

/**
 * Looser normalizer used ONLY for diary→house matching. Everything here is
 * additive on top of normalizeVenueKey: curly apostrophes (Mezzanine's catalog
 * emits "Audible’s Minetta Lane Theatre"), a trailing city clause
 * ("Marquis Theatre, New York"), periods ("St. James" vs "St James"), a
 * leading "the", and collapsed whitespace.
 */
export function normalizeForMatch(venue?: string | null): string {
  const base = normalizeVenueKey(venue);
  if (!base) return '';
  return base
    .replace(/[‘’ʼʹ]/g, "'")
    .replace(/[“”]/g, '"')
    // Trailing city/qualifier clause, then re-strip the theatre suffix that
    // the clause was hiding from normalizeVenueKey.
    .replace(/,.*$/, '')
    .replace(/ theatre$| theater$/, '')
    .replace(/\./g, '')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markets whose venues are never Broadway houses. */
const NON_BROADWAY_CATEGORIES = new Set([
  'off-broadway',
  'west-end',
  'off-west-end',
  'regional',
  'us-regional',
  'uk-regional',
  'touring',
]);

/**
 * True when a show's category permits matching against Broadway house metadata.
 *
 * This gate is load-bearing, not defensive: London's Palace Theatre normalizes
 * to the same key as Broadway's Palace Theatre, so without it the owner's West
 * End Cursed Child logs a phantom Broadway house visit (measured 2026-07-26).
 * Unknown/absent categories are allowed through — diary imports occasionally
 * omit it and Broadway is the dominant case.
 */
export function isBroadwayHouseCandidate(category?: string | null): boolean {
  if (!category) return true;
  return !NON_BROADWAY_CATEGORIES.has(category);
}

export interface HouseIndex {
  /** Canonical house names, in metadata order. */
  houses: string[];
  /** normalizeVenueKey(name) → canonical name. */
  exact: Map<string, string>;
  /** normalizeForMatch(name or alias) → canonical name. */
  loose: Map<string, string>;
}

/** Alias entries shipped as data (see venue-aliases.json). */
export type VenueAliasTable = Record<string, string>;

/**
 * Build a lookup index over the operating-house names (the keys of
 * data/theater-metadata.json, minus `_meta`).
 *
 * @param houseNames canonical house names
 * @param extraAliases alias → canonical name; merged over the shipped table
 * @param formerNames canonical name → previous names (theater-metadata `formerNames`)
 */
export function buildHouseIndex(
  houseNames: string[],
  extraAliases: VenueAliasTable = {},
  formerNames: Record<string, string[]> = {}
): HouseIndex {
  const houses = houseNames.filter((n) => n && !n.startsWith('_'));
  const exact = new Map<string, string>();
  const loose = new Map<string, string>();

  for (const name of houses) {
    const e = normalizeVenueKey(name);
    if (e && !exact.has(e)) exact.set(e, name);
    const l = normalizeForMatch(name);
    if (l && !loose.has(l)) loose.set(l, name);
  }

  // formerNames from theater-metadata (e.g. Lena Horne ← Brooks Atkinson).
  for (const [canonical, previous] of Object.entries(formerNames)) {
    if (!houses.includes(canonical)) continue;
    for (const prev of previous || []) {
      const l = normalizeForMatch(prev);
      if (l && !loose.has(l)) loose.set(l, canonical);
    }
  }

  // Shipped alias table, then caller overrides. Aliases pointing at a house
  // that is not in the index are ignored (house closed / renamed away).
  for (const [alias, canonical] of Object.entries({
    ...(aliasTable as VenueAliasTable),
    ...extraAliases,
  })) {
    if (alias.startsWith('_')) continue;
    if (!houses.includes(canonical)) continue;
    const l = normalizeForMatch(alias);
    if (l && !loose.has(l)) loose.set(l, canonical);
  }

  return { houses, exact, loose };
}

export interface MatchOptions {
  /** Show category (`broadway`, `off-broadway`, `west-end`, …). */
  category?: string | null;
}

/**
 * Resolve a diary venue string to a canonical Broadway house name, or null
 * when the venue is not an operating Broadway house (Off-Broadway, West End,
 * regional, or simply unknown).
 */
export function matchVenueToHouse(
  venue: string | null | undefined,
  index: HouseIndex,
  opts: MatchOptions = {}
): string | null {
  if (!venue) return null;
  if (!isBroadwayHouseCandidate(opts.category)) return null;
  const e = normalizeVenueKey(venue);
  if (e && index.exact.has(e)) return index.exact.get(e)!;
  const l = normalizeForMatch(venue);
  if (l && index.loose.has(l)) return index.loose.get(l)!;
  return null;
}

/** The shipped alias table, exported so tests and tooling can inspect it. */
export const VENUE_ALIASES = aliasTable as VenueAliasTable;
