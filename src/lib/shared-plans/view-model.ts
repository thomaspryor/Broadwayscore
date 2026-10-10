/**
 * Shared Plans: turn a loaded share into the plain props the page renders
 * (BRO-4481). Server-side and pure apart from the injected resolver, so the
 * page, its preview image and tests all build the same thing.
 */
import { buildPlannedShowEvent } from '@/lib/calendar-event';
import type { PerformanceEvent } from '@/lib/calendar';
import { formatShowDate } from '@/lib/date-utils';
import type { BookabilitySource } from '@/components/user/upcoming-cards';
import { selectSharedPlans, type SharedPlansPayload } from './select';
import type { PlanShow } from './resolve';

export interface PlanShowView {
  id: string;
  title: string;
  href: string;
  posterUrl: string | null;
  venue: string;
  /** For the Watchlist-style status badge; null for catalog-only shows. */
  bookability: BookabilitySource | null;
}

export interface BookedPlanView extends PlanShowView {
  /** YYYY-MM-DD */
  date: string;
  /** "Oct 18" — the My Shows Upcoming grid label. */
  dateLabel: string;
  /** All-day event for AddToCalendarButtons (null if it can't be built). */
  event: PerformanceEvent | null;
}

export interface SharedPlansView {
  name: string;
  booked: BookedPlanView[];
  unbooked: PlanShowView[];
  counts: { booked: number; unbooked: number };
}

function toView(show: PlanShow): PlanShowView {
  return { id: show.id, title: show.title, href: show.href, posterUrl: show.posterUrl, venue: show.venue, bookability: show.bookability };
}

export function buildSharedPlansView(
  payload: SharedPlansPayload,
  shows: ReadonlyMap<string, PlanShow>,
  nowMs: number,
): SharedPlansView {
  const selected = selectSharedPlans(payload, shows, nowMs);
  return {
    name: payload.name,
    booked: selected.booked.map(({ show, date }) => {
      // allDay: friends only ever see the date (owner decision). The calendar
      // module adds the 🎭 prefix itself; the owner goes in as a companion.
      const ev = buildPlannedShowEvent(show.calendar, { planned_date: date, curtain_time: null }, {
        allDay: true, companions: [payload.name],
      });
      return {
        ...toView(show),
        date,
        dateLabel: formatShowDate(date, { month: 'short', day: 'numeric' }),
        event: ev,
      };
    }),
    unbooked: selected.unbooked.map(({ show }) => toView(show)),
    counts: selected.counts,
  };
}

/** "Tom's theater plans" / "Chris' theater plans". */
export function plansTitle(name: string): string {
  const n = name.trim();
  return `${n}${/s$/i.test(n) ? '’' : '’s'} theater plans`;
}

/** "3 booked · 7 want to see" (sections with nothing are left out). */
export function plansSummary(counts: { booked: number; unbooked: number }): string {
  const parts: string[] = [];
  if (counts.booked) parts.push(`${counts.booked} upcoming`);
  if (counts.unbooked) parts.push(`${counts.unbooked} not yet booked`);
  return parts.length ? parts.join(' · ') : 'Nothing planned right now';
}
