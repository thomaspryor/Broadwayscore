/**
 * Could a user have seen this show yet? (BRO-77)
 *
 * Rate controls (the hover stars on every browse card and on the show-page
 * poster) must not invite a rating for a show nobody has been able to watch:
 * an `announced` show with no dates, or an `upcoming` show whose first preview
 * is still in the future. Same bug class as the watchlist fix (#258).
 *
 * Status is the primary signal. Dates rescue a status that lags reality (the
 * status pipeline runs on a schedule, so a show can still read `upcoming` on
 * the night its first preview plays): an upcoming/announced show whose first
 * preview or opening date is today or earlier counts as seeable. An unknown
 * status falls open, since hiding the control is the costlier mistake there.
 */
export interface RateabilitySource {
  status?: string | null;
  previewsStartDate?: string | null;
  openingDate?: string | null;
}

const NOT_YET_SEEABLE = new Set(['upcoming', 'announced']);

/** Local calendar date as YYYY-MM-DD (the viewer's own "today"). */
export function localTodayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Does the answer depend on today's date? Only for upcoming/announced shows.
 * For every other status it is fixed, so components can decide it during
 * render (identical on server and client) and defer only these to after
 * mount, where the viewer's clock is safe to read.
 */
export function dependsOnDate(status: string | null | undefined): boolean {
  return !!status && NOT_YET_SEEABLE.has(status);
}

/**
 * Has a date-only YYYY-MM-DD start date arrived, by the viewer's local
 * calendar? (A bare `new Date('YYYY-MM-DD')` is UTC midnight, which shows
 * things a day early in the Americas.) Unparseable or missing -> true.
 */
export function hasLocalDateArrived(dateStr: string | null | undefined, today: string = localTodayISO()): boolean {
  const d = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  return d <= today;
}

export function couldHaveSeenShow(show: RateabilitySource | null | undefined, today: string = localTodayISO()): boolean {
  if (!show) return true;
  const status = show.status ?? null;
  if (!status || !NOT_YET_SEEABLE.has(status)) return true;
  const start = (show.previewsStartDate || show.openingDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return false;
  return start <= today;
}
