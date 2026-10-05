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

/** Where the tour is today and where it goes next, as of this build. */
export function getTourNowNextForShow(showId: string, today = new Date().toISOString().slice(0, 10)): TourNowNext | null {
  const stops = getTourSchedule(showId);
  return stops.length ? getTourNowNext(stops, today) : null;
}

/** The schedule page the stops were read from. */
export function getTourScheduleSource(showId: string): string | null {
  return schedules.tours[showId]?.source ?? null;
}

/** TodayTix links for the stops on sale there, keyed by stopKey(). */
export function getTourStopTickets(showId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tickets.tours[showId] ?? []) {
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
export function getTourTicketLinks(showId: string, today = new Date().toISOString().slice(0, 10)): TicketLink[] {
  const nn = getTourNowNextForShow(showId, today);
  const byStop = getTourStopTickets(showId);
  const stop = nn?.now ?? nn?.next;
  const url = stop ? byStop[stopKey(stop)] : undefined;
  return url ? [{ platform: TOUR_TICKET_PLATFORM, url }] : [];
}
