/**
 * Shared Plans: which of a person's watchlist rows a friend sees, and where
 * (BRO-4481, docs/specs/shared-plans.md §2.2).
 *
 * ONE rule, used by the public page, its preview image and the owner's share
 * sheet counts, so the numbers on the sheet, the link preview and the page can
 * never disagree. The iOS app ports this file (lib/shared-plans-select.ts) and
 * both are tested against tests/fixtures/shared-plans-parity.json, which the
 * SQL function get_shared_plans() is tested against too.
 *
 * Pure: no I/O, no React, no clock reads — `nowMs` is passed in.
 */
import { resolveTimeZone, utcToWallTime } from '@/lib/calendar/timezone';

/** What get_shared_plans() returns (supabase/migrations/20261001_plan_shares.sql). */
export interface SharedPlansPayload {
  name: string;
  showBooked: boolean;
  showUnbooked: boolean;
  entries: SharedPlanEntry[];
}

export interface SharedPlanEntry {
  show_id: string;
  /** YYYY-MM-DD or null when not booked. */
  planned_date: string | null;
  /** The outing for planned_date is already in the diary (iOS watchlist-slot rule). */
  logged: boolean;
}

/** The minimum a resolved show needs for the rule. Callers pass richer objects through. */
export interface PlanShowLike {
  id: string;
  category?: string | null;
  status?: string | null;
}

export interface SelectedSharedPlans<T extends PlanShowLike> {
  /** Soonest first. */
  booked: Array<{ show: T; date: string }>;
  /** In the owner's watchlist order (newest first). */
  unbooked: Array<{ show: T }>;
  counts: { booked: number; unbooked: number };
}

/**
 * "Today" at the show's venue. A plan is still upcoming until the venue's
 * calendar day ends, wherever the viewer is: a friend in Tokyo still sees
 * tonight's New York show. Unmapped markets fall back to New York, the site's
 * home market.
 */
export function venueToday(category: string | null | undefined, nowMs: number): string {
  const tz = resolveTimeZone(category) ?? 'America/New_York';
  return utcToWallTime(nowMs, tz).date;
}

export function selectSharedPlans<T extends PlanShowLike>(
  payload: Pick<SharedPlansPayload, 'showBooked' | 'showUnbooked' | 'entries'>,
  shows: ReadonlyMap<string, T>,
  nowMs: number,
): SelectedSharedPlans<T> {
  const booked: Array<{ show: T; date: string; order: number }> = [];
  const unbooked: Array<{ show: T }> = [];

  payload.entries.forEach((entry, order) => {
    const show = shows.get(entry.show_id);
    // Ids the build doesn't know (deleted shows, typos) are dropped rather
    // than rendered as raw ids.
    if (!show) return;

    if (entry.planned_date && entry.planned_date >= venueToday(show.category, nowMs)) {
      if (payload.showBooked) booked.push({ show, date: entry.planned_date, order });
      return;
    }
    // Not booked: no date yet, or a past date whose outing is already logged
    // (the app's "not-booked" shelf). A past, unlogged date is the owner's
    // private "to be rated" list and is never shown.
    if (entry.planned_date === null || entry.logged) {
      // A friend can't join a closed show.
      if (payload.showUnbooked && show.status !== 'closed') unbooked.push({ show });
    }
  });

  booked.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  return {
    booked: booked.map(({ show, date }) => ({ show, date })),
    unbooked,
    counts: { booked: booked.length, unbooked: unbooked.length },
  };
}

/**
 * Build entries from the owner's own rows, for the share sheet's counts. Same
 * `logged` rule as get_shared_plans(): a review of that show dated on/after the
 * planned date, or an undated review, means the outing is already logged.
 * Input order is kept (pass the watchlist newest first, as the page shows it).
 */
export function toSharedEntries(
  watchlist: ReadonlyArray<{ show_id: string; planned_date: string | null }>,
  reviews: ReadonlyArray<{ show_id: string; date_seen: string | null }>,
): SharedPlanEntry[] {
  return watchlist.map(w => ({
    show_id: w.show_id,
    planned_date: w.planned_date,
    logged: w.planned_date !== null && reviews.some(r =>
      r.show_id === w.show_id && (r.date_seen === null || r.date_seen >= (w.planned_date as string))),
  }));
}
