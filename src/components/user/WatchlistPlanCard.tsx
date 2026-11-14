'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { formatTime } from '@/lib/calendar/format';
import type { PerformanceEvent } from '@/lib/calendar';
import type { WatchlistEntry } from '@/types/user';

export type TimeFields = Pick<WatchlistEntry, 'time_slot' | 'curtain_time'>;

const PlanSheet = dynamic(() => import('./PlanSheet'), { ssr: false });

export interface WatchlistPlanCardProps {
  showId: string;
  showTitle: string;
  entry: WatchlistEntry;
  /** From buildPlannedShowEvent; null hides "Add to calendar". */
  event: PerformanceEvent | null;
  onDateChange: (date: string | null) => Promise<unknown>;
  onShowtimeChange: (fields: TimeFields) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}

/**
 * The show page's "your plans" card for a watchlisted show: one tappable row
 * (date tile, "Seeing it Sat, Oct 24", "Evening · 7:00 PM") that opens a
 * sheet with the date, three large showtime buttons, Add to calendar and
 * Remove from watchlist. Replaced a 12px caption that held the date link and
 * the 10px Matinee / Evening / Custom chips (owner, 2026-10-03: "tiny and
 * unprofessional"). Same row look as the rating rows in ShowHeroRedesign.
 */
export default function WatchlistPlanCard(props: WatchlistPlanCardProps) {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  // Mount the sheet on first tap (its chunk loads then); keep it mounted after so close animates.
  const [opened, setOpened] = useState(false);
  const date = entry.planned_date;

  return (
    <>
      <PlanRow
        onClick={() => { setOpened(true); setOpen(true); }}
        ariaLabel={date ? `Your plans: ${planTitle(date)}. Edit` : 'Add the date you are going'}
        tile={date ? <DateTile date={date} accent /> : <IconTile />}
        title={date ? `Seeing it ${planTitle(date)}` : 'When are you going?'}
        subtitle={date ? (showtimeLabel(entry) ?? 'Add a showtime') : 'Add a date and showtime'}
        testId="watchlist-plan-card"
      />
      {opened && <PlanSheet {...props} isOpen={open} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Shared row: tile + title + subtitle + chevron, one 44px+ tap target. */
export function PlanRow({ onClick, ariaLabel, tile, title, subtitle, children, testId }: {
  onClick: () => void;
  /** Omit to let screen readers read the row's own text. */
  ariaLabel?: string;
  tile: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      data-testid={testId}
      className="card-interactive w-full flex items-center gap-3 p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      {tile}
      <span className="min-w-0 flex-1">
        <span className="block text-sm sm:text-base font-semibold text-white truncate">{title}</span>
        {subtitle && <span className="block text-xs sm:text-sm text-gray-400 truncate mt-0.5">{subtitle}</span>}
        {children}
      </span>
      <svg className="w-4 h-4 flex-shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

/** Month over day, e.g. OCT / 24. `accent` = an upcoming plan (amber). */
export function DateTile({ date, accent = false }: { date: string; accent?: boolean }) {
  const d = new Date(date + 'T00:00:00');
  return (
    <span
      className={`flex-shrink-0 w-12 h-12 rounded-lg flex flex-col items-center justify-center leading-none ${
        accent ? 'bg-amber-400/15 text-amber-300' : 'bg-white/[0.06] text-gray-200'
      }`}
      aria-hidden="true"
    >
      <span className="text-xs font-semibold uppercase tracking-wide">{d.toLocaleDateString('en-US', { month: 'short' })}</span>
      <span className="text-lg font-bold mt-0.5">{d.getDate()}</span>
    </span>
  );
}

function IconTile() {
  return (
    <span className="flex-shrink-0 w-12 h-12 rounded-lg bg-white/[0.06] text-gray-300 flex items-center justify-center" aria-hidden="true">
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    </span>
  );
}

/** "Sat, Oct 24" */
function planTitle(date: string): string {
  return new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Evening · 7:00 PM", "7:30 PM" (custom), or null when none is set. */
export function showtimeLabel(entry: Pick<WatchlistEntry, 'time_slot' | 'curtain_time'>): string | null {
  const time = entry.curtain_time ? formatTime(entry.curtain_time.slice(0, 5)) : null;
  if (entry.time_slot === 'matinee') return time ? `Matinee · ${time}` : 'Matinee';
  if (entry.time_slot === 'evening') return time ? `Evening · ${time}` : 'Evening';
  if (entry.time_slot === 'custom') return time;
  return null;
}
