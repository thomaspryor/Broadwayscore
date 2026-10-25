/**
 * theaterCompletion — the Broadway house completion ring, checklist and
 * records (spec §3.3).
 *
 * The denominator is the set of currently-operating houses, which is exactly
 * the key set of data/theater-metadata.json (minus the `_meta` entry). Venues
 * that don't resolve to one of those keys are not failures — they're
 * Off-Broadway, West End and regional houses — so they're reported separately
 * as `extraCredit` rather than dragging the ring down.
 *
 * Pure: theater metadata is passed in, never read from disk here.
 */

import type { DiaryRow, ShowMetaIndex } from './types';
import { buildHouseIndex, matchVenueToHouse, normalizeForMatch } from './venue-match';
import type { HouseIndex, VenueAliasTable } from './venue-match';

/** Only the fields this reducer reads out of data/theater-metadata.json. */
export interface HouseMeta {
  capacity?: number | null;
  yearBuilt?: number | null;
  formerNames?: string[];
}

export type TheaterMetadata = Record<string, HouseMeta | Record<string, unknown>>;

export interface HouseVisit {
  name: string;
  visited: boolean;
  count: number;
  capacity: number | null;
  yearBuilt: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface ExtraCreditVenue {
  venue: string;
  count: number;
}

export interface TheaterCompletion {
  /** Operating houses in the denominator. */
  operating: number;
  /** Distinct operating houses visited. */
  visited: number;
  /** visited / operating, 0–1. */
  completion: number;
  /** Every operating house, visited first (by count desc), then A–Z. */
  houses: HouseVisit[];
  unvisited: string[];
  /** Venues that matched no operating house, most-visited first. */
  extraCredit: ExtraCreditVenue[];
  records: {
    homeTheater: HouseVisit | null;
    biggest: HouseVisit | null;
    smallest: HouseVisit | null;
    oldest: HouseVisit | null;
  };
  /** Σ capacity of the house for every logged visit to a known house. */
  totalAudience: number;
}

export interface TheaterCompletionOptions {
  houseIndex?: HouseIndex;
  extraAliases?: VenueAliasTable;
}

function isHouseKey(key: string): boolean {
  return !key.startsWith('_');
}

export function theaterCompletion(
  rows: DiaryRow[],
  showMeta: ShowMetaIndex,
  theaterMetadata: TheaterMetadata,
  opts: TheaterCompletionOptions = {}
): TheaterCompletion {
  const houseNames = Object.keys(theaterMetadata ?? {}).filter(isHouseKey);
  const formerNames: Record<string, string[]> = {};
  for (const name of houseNames) {
    const meta = theaterMetadata[name] as HouseMeta | undefined;
    if (meta?.formerNames?.length) formerNames[name] = meta.formerNames;
  }
  const index =
    opts.houseIndex ?? buildHouseIndex(houseNames, opts.extraAliases ?? {}, formerNames);

  const visits = new Map<string, { count: number; first: string | null; last: string | null }>();
  const extra = new Map<string, number>();
  let totalAudience = 0;

  for (const row of rows) {
    const meta = showMeta[row.show_id];
    const venue = meta?.venue;
    if (!venue || !normalizeForMatch(venue)) continue;

    const house = matchVenueToHouse(venue, index, { category: meta?.category });
    if (!house) {
      extra.set(venue, (extra.get(venue) ?? 0) + 1);
      continue;
    }

    const v = visits.get(house) ?? { count: 0, first: null, last: null };
    v.count++;
    if (row.date_seen) {
      if (v.first === null || row.date_seen < v.first) v.first = row.date_seen;
      if (v.last === null || row.date_seen > v.last) v.last = row.date_seen;
    }
    visits.set(house, v);

    const capacity = (theaterMetadata[house] as HouseMeta | undefined)?.capacity;
    if (typeof capacity === 'number' && Number.isFinite(capacity)) totalAudience += capacity;
  }

  const houses: HouseVisit[] = houseNames.map((name) => {
    const meta = theaterMetadata[name] as HouseMeta | undefined;
    const v = visits.get(name);
    return {
      name,
      visited: !!v,
      count: v?.count ?? 0,
      capacity: typeof meta?.capacity === 'number' ? meta.capacity : null,
      yearBuilt: typeof meta?.yearBuilt === 'number' ? meta.yearBuilt : null,
      firstSeen: v?.first ?? null,
      lastSeen: v?.last ?? null,
    };
  });

  houses.sort((a, b) => {
    if (a.visited !== b.visited) return a.visited ? -1 : 1;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });

  const visitedHouses = houses.filter((h) => h.visited);
  const withCapacity = visitedHouses.filter((h) => h.capacity !== null);
  const withYear = visitedHouses.filter((h) => h.yearBuilt !== null);

  const pick = <T>(list: T[], better: (a: T, b: T) => boolean): T | null =>
    list.length ? list.reduce((best, x) => (better(x, best) ? x : best)) : null;

  return {
    operating: houseNames.length,
    visited: visitedHouses.length,
    completion: houseNames.length ? visitedHouses.length / houseNames.length : 0,
    houses,
    unvisited: houses.filter((h) => !h.visited).map((h) => h.name),
    extraCredit: Array.from(extra.entries())
      .map(([venue, count]) => ({ venue, count }))
      .sort((a, b) => b.count - a.count || a.venue.localeCompare(b.venue)),
    records: {
      homeTheater: visitedHouses[0] ?? null,
      biggest: pick(withCapacity, (a, b) => (a.capacity ?? 0) > (b.capacity ?? 0)),
      smallest: pick(withCapacity, (a, b) => (a.capacity ?? 0) < (b.capacity ?? 0)),
      oldest: pick(withYear, (a, b) => (a.yearBuilt ?? 0) < (b.yearBuilt ?? 0)),
    },
    totalAudience,
  };
}
