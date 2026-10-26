/**
 * Pure formatting + grouping helpers for the web Stats view (BRO-6170).
 * Ported from the iOS app (HeroTiles.formatHours, lib/stats-months.ts,
 * TheaterTracker.houseShortName, lib/stats-drilldown.ts).
 */

/** "122h 45m": never a bare decimal, which reads as a rating. */
export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Hours only, with thousands separators ("1,204"): the hero tile number. */
export function wholeHours(minutes: number): string {
  return Math.round(minutes / 60).toLocaleString('en-US');
}

/** "2025-10" → "October 2025" */
export function formatMonth(key: string): string {
  const [y, m] = key.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/** "2025-10" → "Oct" */
export function shortMonth(key: string): string {
  const [y, m] = key.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

/** "2025-10-04" → "Oct 4, 2025" */
export function formatDateSeen(dateSeen: string | null): string {
  if (!dateSeen) return 'No date';
  return new Date(dateSeen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Short display name for a house chip ("Gerald Schoenfeld Theatre" →
 * "Schoenfeld"). An explicit table beats regexes: a long house name once fell
 * through a suffix-stripping regex on iOS and rendered truncated.
 */
const HOUSE_SHORT_NAMES: Record<string, string> = {
  'Circle in the Square Theatre': 'Circle in the Sq.',
  'Vivian Beaumont Theater': 'Beaumont',
  'Lunt-Fontanne Theatre': 'Lunt-Fontanne',
  'New Amsterdam Theatre': 'New Amsterdam',
  'Winter Garden Theatre': 'Winter Garden',
  'Al Hirschfeld Theatre': 'Hirschfeld',
  'Stephen Sondheim Theatre': 'Sondheim',
  'Samuel J. Friedman Theatre': 'Friedman',
  'Bernard B. Jacobs Theatre': 'Jacobs',
  'Gerald Schoenfeld Theatre': 'Schoenfeld',
  'James Earl Jones Theatre': 'James Earl Jones',
  'Ethel Barrymore Theatre': 'Barrymore',
  'Eugene O’Neill Theatre': 'O’Neill',
  "Eugene O'Neill Theatre": "O'Neill",
  'Helen Hayes Theater': 'Hayes',
  'Walter Kerr Theatre': 'Kerr',
  'Richard Rodgers Theatre': 'Rodgers',
  'Todd Haimes Theatre': 'Haimes',
  'Lena Horne Theatre': 'Lena Horne',
  'August Wilson Theatre': 'August Wilson',
  'Ambassador Theatre': 'Ambassador',
  'Nederlander Theatre': 'Nederlander',
  'John Golden Theatre': 'Golden',
  'Neil Simon Theatre': 'Neil Simon',
  'Music Box Theatre': 'Music Box',
  'St. James Theatre': 'St. James',
  'Broadway Theatre': 'Broadway',
};

export function houseShortName(name: string): string {
  return HOUSE_SHORT_NAMES[name] ?? name.replace(/\s+(Theatre|Theater)$/i, '').replace(/^Lincoln Center Theater\s*-\s*/i, '').trim();
}

export interface VenueGroup<T> {
  venue: string;
  reviews: T[];
}

/** Group rows by venue, largest group first (ties alphabetical). */
export function groupByVenue<T extends { show_id: string }>(
  rows: T[],
  venueForShow: (showId: string) => string | null | undefined,
): VenueGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const venue = venueForShow(r.show_id) || 'Unknown venue';
    const bucket = groups.get(venue);
    if (bucket) bucket.push(r);
    else groups.set(venue, [r]);
  }
  return Array.from(groups, ([venue, reviews]) => ({ venue, reviews })).sort(
    (a, b) => b.reviews.length - a.reviews.length || a.venue.localeCompare(b.venue),
  );
}

/** Initials for a critic avatar: "Jesse Green" → "JG". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase();
}
