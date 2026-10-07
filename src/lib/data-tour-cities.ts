// National-tour city pages (BRO-4601 phase 5): which cities get a page, and
// what each lists. Built from data/tour-schedules.json via data-tour-schedule.
//
// A page counts only tours that are listed (isTourListed: enough reviews for
// a score) and not closed. It exists while the city had MIN_TOURS such tours
// playing there in the trailing year or booked ahead, so a city whose stops
// have passed keeps its URL ("recently played") instead of turning into a
// 404 between deploys. It is indexed, and in the sitemap, only with
// INDEX_MIN_TOURS listed tours still to come.

import { getAllShows, isTourListed } from './data-core';
import { getTourSchedule } from './data-tour-schedule';
import { cityStops, type CityStop } from './tour-cities';
import type { ComputedShow } from './engine';

export { citySlug } from './tour-cities';
export type { CityStop } from './tour-cities';

export const MIN_TOURS = 3;
export const INDEX_MIN_TOURS = 5;
const RECENT_DAYS = 365;

export interface TourCity {
  slug: string;
  /** "San Francisco, CA" */
  city: string;
  /** Every stop in the city by a non-closed tour, in date order. */
  stops: Array<CityStop & { show: ComputedShow }>;
  /** Listed tours with a stop still to come. */
  upcomingListed: number;
  indexed: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

function addDays(d: string, n: number) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

const cache = new Map<string, Map<string, TourCity>>();

/** Every city with a page, keyed by slug, as of `on` (YYYY-MM-DD). */
export function getTourCities(on = today()): Map<string, TourCity> {
  const hit = cache.get(on);
  if (hit) return hit;
  const tours = getAllShows().filter(s => s.category === 'tour' && s.status !== 'closed');
  const byShow = new Map(tours.map(s => [s.id, s]));
  const grouped = cityStops(tours.map(s => ({ id: s.id, stops: getTourSchedule(s.id) })));
  const since = addDays(on, -RECENT_DAYS);
  const out = new Map<string, TourCity>();
  grouped.forEach(({ city, stops }, slug) => {
    const withShow = stops.map(s => ({ ...s, show: byShow.get(s.showId)! }));
    const listed = withShow.filter(s => isTourListed(s.show));
    const recentOrAhead = new Set(listed.filter(s => s.end >= since).map(s => s.showId));
    if (recentOrAhead.size < MIN_TOURS) return;
    const upcomingListed = new Set(listed.filter(s => s.end >= on).map(s => s.showId)).size;
    const shown = withShow.filter(s => s.end >= since);
    out.set(slug, {
      slug, city,
      stops: shown,
      upcomingListed,
      indexed: upcomingListed >= INDEX_MIN_TOURS,
    });
  });
  cache.set(on, out);
  return out;
}

export function getTourCity(slug: string, on = today()): TourCity | undefined {
  return getTourCities(on).get(slug);
}
