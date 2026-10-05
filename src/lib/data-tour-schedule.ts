// National-tour schedule data module (BRO-4601).
// Imports: tour-schedules.json (scripts/fetch-tour-schedules.js),
// tour-tickets.json (scripts/fetch-tour-tickets.js).

import scheduleData from '../../data/tour-schedules.json';
import ticketData from '../../data/tour-tickets.json';
import { getTourNowNext, stopKey, type TourStop, type TourNowNext } from './tour-schedule';
import type { TicketLink } from './engine';

interface TourScheduleFile {
  tours: Record<string, { source: string; updatedAt: string; stops: TourStop[] }>;
}

const schedules = scheduleData as unknown as TourScheduleFile;

interface TourTicketsFile {
  tours: Record<string, Array<{ city: string; start: string; url: string; onSale: boolean }>>;
}

const tickets = ticketData as unknown as TourTicketsFile;

/** TodayTix platform key: buildAffiliateUrl wraps it at click time. */
const TOUR_TICKET_PLATFORM = 'TodayTix';

/** Every engagement of the tour, in date order. Empty when unknown. */
export function getTourSchedule(showId: string): TourStop[] {
  return schedules.tours[showId]?.stops ?? [];
}

/** The tour fields the live-tour helpers need. */
export interface TourRef { id: string; status?: string }

/**
 * Where the tour is today and where it goes next, as of this build. Null for
 * a closed tour: its schedule can still hold dates the source never pulled,
 * and a closed page must not say "Now in" or sell tickets (BRO-4723).
 */
export function getTourNowNextForShow(show: TourRef, today = new Date().toISOString().slice(0, 10)): TourNowNext | null {
  if (show.status === 'closed') return null;
  const stops = getTourSchedule(show.id);
  return stops.length ? getTourNowNext(stops, today) : null;
}

/** The schedule page the stops were read from. */
export function getTourScheduleSource(showId: string): string | null {
  return schedules.tours[showId]?.source ?? null;
}

/** TodayTix links for the stops on sale there, keyed by stopKey(). None for a closed tour. */
export function getTourStopTickets(show: TourRef): Record<string, string> {
  const out: Record<string, string> = {};
  if (show.status === 'closed') return out;
  for (const t of tickets.tours[show.id] ?? []) {
    if (t.onSale) out[stopKey({ city: t.city, start: t.start, venue: '', end: '' })] = t.url;
  }
  return out;
}

/**
 * The tour's ticket button: the TodayTix link for the stop playing now, else
 * for the next stop, and only when that stop is on sale there. Any other
 * stop's link would send a buyer to a city the page isn't talking about, so
 * those stay on the schedule rows.
 */
export function getTourTicketLinks(show: TourRef, today = new Date().toISOString().slice(0, 10)): TicketLink[] {
  const nn = getTourNowNextForShow(show, today);
  const byStop = getTourStopTickets(show);
  const stop = nn?.now ?? nn?.next;
  const url = stop ? byStop[stopKey(stop)] : undefined;
  return url ? [{ platform: TOUR_TICKET_PLATFORM, url }] : [];
}
