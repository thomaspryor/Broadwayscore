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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** "Nov 6", "Nov 6–21", "Jan 19–Feb 7". Dates are YYYY-MM-DD. */
export function stopDateRange(start: string, end: string): string {
  if (start === end) return md(start);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${md(start)}–${Number(end.slice(8, 10))}`;
  return `${md(start)}–${md(end)}`;
}

/** A tour's engagement in one city, as the tours hub's city picker needs it. */
export interface CityAgendaStop {
  showId: string;
  venue: string;
  start: string;
  end: string;
  ticketUrl?: string;
}

export interface CityAgenda {
  /** Playing on `today`, soonest-closing first. */
  now: CityAgendaStop[];
  /** Starting after `today`, grouped by the month they open in ("November 2026"), soonest first. */
  coming: Array<{ month: string; stops: CityAgendaStop[] }>;
  /** How many stops `coming` holds. */
  comingCount: number;
}

const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * What a city has on `today` (YYYY-MM-DD) and what is coming, for the tours
 * hub's "Touring near you" view (BRO-6544). Ended stops are dropped; at most
 * `limit` upcoming stops are kept (the city page has the rest).
 */
export function cityAgenda(stops: CityAgendaStop[], today: string, limit = Infinity): CityAgenda {
  const now = stops.filter(s => s.start <= today && today <= s.end).sort((a, b) => a.end.localeCompare(b.end));
  const ahead = stops.filter(s => s.start > today).sort((a, b) => a.start.localeCompare(b.start) || a.showId.localeCompare(b.showId));
  const coming: CityAgenda['coming'] = [];
  for (const s of ahead.slice(0, limit)) {
    const month = `${LONG_MONTHS[Number(s.start.slice(5, 7)) - 1]} ${s.start.slice(0, 4)}`;
    const last = coming[coming.length - 1];
    if (last && last.month === month) last.stops.push(s);
    else coming.push({ month, stops: [s] });
  }
  return { now, coming, comingCount: ahead.length };
}
