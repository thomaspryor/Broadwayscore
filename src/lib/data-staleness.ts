/**
 * Page-level "this data is stale" decision for the ticket-discovery pages
 * (lotteries, rush, standing room, discount tickets, box office). BRO-901.
 *
 * The quiet "Updated <date>" line under each page title is easy to miss on a
 * phone, so when a feed stops refreshing users get no cue that a lottery or
 * rush policy may have changed. These helpers decide when to show a visible
 * banner and what it says; DataStalenessBanner renders it.
 *
 * Thresholds sit above each feed's normal refresh gap so a healthy feed never
 * trips them: lottery/rush/SRO refreshes Mon + Thu (update-lottery-rush.yml,
 * max normal gap 4 days). Grosses are measured from the WEEK THEY COVER, not
 * the last scrape (a scraper that keeps succeeding while no new week is
 * published would otherwise never warn), using the same rule as the build's
 * box-office status gate: calendar days since the week-ending date, stale
 * past MAX_GROSSES_AGE_DAYS (grosses-week.ts).
 */

import { MAX_GROSSES_AGE_DAYS, calendarDaysBetween, mdyToIso } from './grosses-week';
import { localTodayISO } from './show-rateability';

export type StalenessKind = 'ticket-policies' | 'grosses';

export const STALENESS_THRESHOLD_DAYS: Record<StalenessKind, number> = {
  'ticket-policies': 7,
  grosses: MAX_GROSSES_AGE_DAYS,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between `lastUpdated` and `now`; null for a missing/unparseable date. */
export function daysSinceUpdate(lastUpdated: string | null | undefined, now: number = Date.now()): number | null {
  if (!lastUpdated) return null;
  const t = Date.parse(lastUpdated);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/**
 * Days to show in the banner, or null when the data is fresh enough.
 * A missing or unparseable date returns null: the banner states a number of
 * days, and inventing one would be worse than the quiet line.
 */
export function staleDays(lastUpdated: string | null | undefined, thresholdDays: number, now: number = Date.now()): number | null {
  return staleDaysFor({ kind: 'ticket-policies', lastUpdated, thresholdDays }, now);
}

/**
 * Age in days of the weekly grosses: calendar days since the week-ending date
 * (the box-office status gate's rule), or since the last scrape when that is
 * older. Falls back to the scrape age when weekEnding does not parse.
 */
export function grossesAgeDays(lastUpdated: string | null | undefined, weekEnding: string | null | undefined, now: number = Date.now()): number | null {
  const scrapeAge = daysSinceUpdate(lastUpdated, now);
  const week = mdyToIso(weekEnding);
  if (!week) return scrapeAge;
  const weekAge = Math.max(0, calendarDaysBetween(week, localTodayISO(new Date(now))));
  return scrapeAge === null ? weekAge : Math.max(weekAge, scrapeAge);
}

/** Banner decision for any feed: days to show, or null when fresh enough. */
export function staleDaysFor(
  { kind, lastUpdated, weekEnding, thresholdDays }: { kind: StalenessKind; lastUpdated: string | null | undefined; weekEnding?: string | null; thresholdDays?: number },
  now: number = Date.now(),
): number | null {
  const threshold = thresholdDays ?? STALENESS_THRESHOLD_DAYS[kind];
  const days = kind === 'grosses' ? grossesAgeDays(lastUpdated, weekEnding, now) : daysSinceUpdate(lastUpdated, now);
  if (days === null) return null;
  return days > threshold ? days : null;
}

export function stalenessMessage(days: number, kind: StalenessKind): string {
  const ago = `${days} day${days === 1 ? '' : 's'} ago`;
  if (kind === 'grosses') {
    return `Heads up: these weekly figures are ${days} day${days === 1 ? '' : 's'} old. Newer weekly grosses may already be out.`;
  }
  return `Heads up: this data was last refreshed ${ago}. Ticket policies may have changed since, so double-check with the official platform before you go.`;
}
