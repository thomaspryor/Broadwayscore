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
 * max normal gap 4 days), grosses weekly on Tue with a Wed retry
 * (weekly-grosses.yml, normal gap up to ~8 days).
 */

export type StalenessKind = 'ticket-policies' | 'grosses';

export const STALENESS_THRESHOLD_DAYS: Record<StalenessKind, number> = {
  'ticket-policies': 7,
  grosses: 10,
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
  const days = daysSinceUpdate(lastUpdated, now);
  if (days === null) return null;
  return days > thresholdDays ? days : null;
}

export function stalenessMessage(days: number, kind: StalenessKind): string {
  const ago = `${days} day${days === 1 ? '' : 's'} ago`;
  if (kind === 'grosses') {
    return `Heads up: these figures were last refreshed ${ago}. Newer weekly grosses may already be out.`;
  }
  return `Heads up: this data was last refreshed ${ago}. Ticket policies may have changed since, so double-check with the official platform before you go.`;
}
