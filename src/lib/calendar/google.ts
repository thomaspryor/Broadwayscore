import type { PerformanceEvent } from './types';
import { hasVTimezone, utcToWallTime, wallTimeToUtc } from './timezone';

/**
 * Google Calendar "add event" template URL. No API, no OAuth, no stored state.
 *
 * Two behaviours the UI copy has to be honest about, because neither is fixable
 * from here: it needs an active Google session (and on a multi-account browser
 * it silently targets whichever account is active, not one the user picked),
 * and it has no UID semantics — every open creates a NEW event, so re-clicking
 * after changing a time leaves the old event behind. That is why iOS/macOS
 * order the buttons Apple-first: the .ics path updates in place, this does not.
 */
export function buildGoogleCalendarUrl(ev: PerformanceEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `🎭 ${ev.title}`,
  });

  if (ev.time) {
    const tz = hasVTimezone(ev.tz) ? ev.tz : null;
    const startUtc = wallTimeToUtc(ev.date, ev.time, tz);
    const endUtc = startUtc + ev.durationMin * 60_000;
    if (tz) {
      // With ctz, Google reads the local wall times in that zone.
      const end = utcToWallTime(endUtc, tz);
      params.set('dates', `${compactLocal(ev.date, ev.time)}/${compactLocal(end.date, end.time)}`);
      params.set('ctz', tz);
    } else {
      const end = utcToWallTime(endUtc, null);
      params.set('dates', `${compactLocal(ev.date, ev.time)}/${compactLocal(end.date, end.time)}`);
    }
  } else {
    // All-day: end date is exclusive, same as ICS.
    const next = utcToWallTime(wallTimeToUtc(ev.date, '00:00', null) + 86_400_000, null);
    params.set('dates', `${ev.date.replace(/-/g, '')}/${next.date.replace(/-/g, '')}`);
  }

  if (ev.location) params.set('location', ev.location);

  const details: string[] = [];
  if (ev.companions?.length) details.push(`With ${ev.companions.join(', ')}`);
  details.push(ev.showUrl);
  if (ev.joinUrl) details.push(ev.joinUrl);
  params.set('details', details.join('\n'));

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function compactLocal(date: string, time: string): string {
  return `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
}
