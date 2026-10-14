// Pure helpers for national-tour city pages (BRO-4601 phase 5): no data
// imports, so tests can call them directly.

import type { TourStop } from './tour-schedule';

export interface CityStop extends TourStop {
  showId: string;
}

/** "San Francisco, CA" → "san-francisco-ca"; "St. Louis, MO" → "st-louis-mo". */
export function citySlug(city: string): string {
  return city
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Every tour's stops grouped by city slug, each city's stops in date order. */
export function cityStops(tours: Array<{ id: string; stops: TourStop[] }>): Map<string, { city: string; stops: CityStop[] }> {
  const out = new Map<string, { city: string; stops: CityStop[] }>();
  for (const t of tours) {
    for (const s of t.stops) {
      const slug = citySlug(s.city);
      if (!slug) continue;
      if (!out.has(slug)) out.set(slug, { city: s.city, stops: [] });
      out.get(slug)!.stops.push({ ...s, showId: t.id });
    }
  }
  out.forEach(c => c.stops.sort((a, b) => a.start.localeCompare(b.start) || a.showId.localeCompare(b.showId)));
  return out;
}

/** "2026–27"-style label for the span the stops cover ("2026–27", or "2027" for one year). */
export function seasonLabel(stops: TourStop[]): string {
  if (!stops.length) return '';
  const first = Number(stops[0].start.slice(0, 4));
  const last = Number(stops.reduce((m, s) => (s.end > m ? s.end : m), stops[0].end).slice(0, 4));
  return first === last ? String(first) : `${first}–${String(last % 100).padStart(2, '0')}`;
}
