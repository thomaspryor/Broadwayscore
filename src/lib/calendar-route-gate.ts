/**
 * Which `.ics` downloads `GET /api/calendar.ics` serves.
 *
 * Timed events launched 2026-11-01 (Shared Plans friends get the owner's real
 * curtain time). CALENDAR_EXPORT_ENABLED=0 is the kill switch for timed `.ics`
 * files if a timezone bug (VTIMEZONE/DST) ever turns up; all-day events carry
 * no time and no timezone, so they are always served.
 *
 * AddToCalendarButtons applies the same rule (isCalendarEventOffered with
 * featureFlags.calendarExport), so the button never offers a 404.
 *
 * Kept out of the route file because Next.js route modules may only export
 * route handlers and config.
 */
import type { PerformanceEvent } from '@/lib/calendar';

/** The one rule: all-day always; timed only when timed export is on. */
export function isCalendarEventOffered(ev: Pick<PerformanceEvent, 'time'>, timedExportOn: boolean): boolean {
  return ev.time === null || timedExportOn;
}

/** Server side (the route): timed export is on unless CALENDAR_EXPORT_ENABLED=0. */
export function isCalendarExportAllowed(
  ev: Pick<PerformanceEvent, 'time'>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isCalendarEventOffered(ev, env.CALENDAR_EXPORT_ENABLED !== '0');
}
