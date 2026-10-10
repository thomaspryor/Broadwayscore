/**
 * Which `.ics` downloads `GET /api/calendar.ics` serves.
 *
 * Timed events stay behind CALENDAR_EXPORT_ENABLED: that gate exists to contain
 * timezone bugs in timed `.ics` files (VTIMEZONE/DST), and the timed feature
 * isn't launched. All-day events carry no time and no timezone, so they are
 * always served — Shared Plans (BRO-4481) shows friends dates only, and its
 * "Add to my calendar" must work in production without that launch.
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

/** Server side (the route): timed export is on when CALENDAR_EXPORT_ENABLED=1. */
export function isCalendarExportAllowed(
  ev: Pick<PerformanceEvent, 'time'>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isCalendarEventOffered(ev, env.CALENDAR_EXPORT_ENABLED === '1');
}
