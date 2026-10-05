// National-tour engagement schedule (BRO-4601). Pure helpers: no data imports,
// so client components and tests can use them. The data comes from
// data/tour-schedules.json (scripts/fetch-tour-schedules.js) via
// data-tour-schedule.ts.

export interface TourStop {
  city: string;
  venue: string;
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD */
  end: string;
}

export interface TourNowNext {
  /** The engagement playing on `today`, if any. */
  now: TourStop | null;
  /** The next engagement to start after `today`. */
  next: TourStop | null;
}

/** Where the tour is on `today` (YYYY-MM-DD) and where it goes next. */
export function getTourNowNext(stops: TourStop[], today: string): TourNowNext {
  const now = stops.find(s => s.start <= today && today <= s.end) ?? null;
  const next = stops.find(s => s.start > today) ?? null;
  return { now, next };
}

const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * The stop a review was written in, by its publish date: the engagement
 * running that day, or one that ended up to 3 days before (a review of the
 * closing weekend). Falls back to the latest stop that had started. Never
 * reads the review URL (CLAUDE.md: no metadata from URLs).
 */
export function stopForReview(stops: TourStop[], publishDate: string | null | undefined): TourStop | null {
  if (!publishDate) return null;
  const d = publishDate.slice(0, 10);
  // The stop actually playing wins: stops are usually 1-3 days apart, so the
  // grace window alone would file a new city's opening-night reviews under
  // the city before (code review, BRO-4601).
  const playing = stops.find(s => s.start <= d && d <= s.end);
  if (playing) return playing;
  const justClosed = stops.find(s => s.end < d && d <= addDays(s.end, 3));
  if (justClosed) return justClosed;
  const started = stops.filter(s => s.start <= d);
  return started.length ? started[started.length - 1] : null;
}

/** "San Diego, CA" → "San Diego" for tight spaces. */
export function shortCity(city: string): string {
  return city.replace(/,\s*[A-Z]{2}$/, '');
}

/** Stable key for a stop: a tour can play the same city twice. */
export function stopKey(s: TourStop): string {
  return `${s.city}|${s.start}`;
}

const CANADA = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

export interface StopPlace {
  locality: string;
  /** State or province code; absent for a country-only suffix (", MX"). */
  region?: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

/**
 * "Toronto, ON" → { locality: Toronto, region: ON, country: CA };
 * "Mexico City, MX" → { locality: Mexico City, country: MX }; anything
 * without a two-letter suffix → US locality only. For Event structured data.
 */
export function stopPlace(city: string): StopPlace {
  const m = city.match(/^(.*?),\s*([A-Z]{2})$/);
  if (!m) return { locality: city.trim(), country: 'US' };
  const [, locality, code] = m;
  if (code === 'MX') return { locality, country: 'MX' };
  return { locality, region: code, country: CANADA.has(code) ? 'CA' : 'US' };
}
