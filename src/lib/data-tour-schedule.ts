// National-tour schedule data module (BRO-4601).
// Imports: tour-schedules.json (scripts/fetch-tour-schedules.js).

import scheduleData from '../../data/tour-schedules.json';
import { getTourNowNext, type TourStop, type TourNowNext } from './tour-schedule';

interface TourScheduleFile {
  tours: Record<string, { source: string; updatedAt: string; stops: TourStop[] }>;
}

const schedules = scheduleData as unknown as TourScheduleFile;

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
