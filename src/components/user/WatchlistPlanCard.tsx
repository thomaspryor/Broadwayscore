'use client';

import { useState } from 'react';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import DatePickerButton from './DatePickerButton';
import AddToCalendarButtons from './AddToCalendarButtons';
import { resolveShowtimeDefault, isKnownDarkForSlot } from '@/lib/data-showtimes';
import { formatTime } from '@/lib/calendar/format';
import type { PerformanceEvent } from '@/lib/calendar';
import type { WatchlistEntry } from '@/types/user';

type TimeFields = Pick<WatchlistEntry, 'time_slot' | 'curtain_time'>;

interface WatchlistPlanCardProps {
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
  const date = entry.planned_date;

  return (
    <>
      <PlanRow
        onClick={() => setOpen(true)}
        ariaLabel={date ? `Your plans: ${planTitle(date)}. Edit` : 'Add the date you are going'}
        tile={date ? <DateTile date={date} accent /> : <IconTile />}
        title={date ? `Seeing it ${planTitle(date)}` : 'When are you going?'}
        subtitle={date ? (showtimeLabel(entry) ?? 'Add a showtime') : 'Add a date and showtime'}
        testId="watchlist-plan-card"
      />
      <PlanSheet {...props} isOpen={open} onClose={() => setOpen(false)} />
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
      <svg className="w-4 h-4 flex-shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
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

function PlanSheet({ showId, showTitle, entry, event, onDateChange, onShowtimeChange, onRemove, isOpen, onClose }: WatchlistPlanCardProps & {
  isOpen: boolean;
  onClose: () => void;
}) {
  // One write at a time: rapid Matinee→Evening taps would otherwise race
  // (ship-check 2026-08-17). Every control in the sheet honours it.
  const [saving, setSaving] = useState(false);
  const guarded = (fn: () => Promise<unknown>) => async () => {
    if (saving) return;
    setSaving(true);
    try { await fn(); } finally { setSaving(false); }
  };
  const date = entry.planned_date;
  const slot = entry.time_slot;

  const slotButton = (key: 'matinee' | 'evening', label: string) => {
    const dark = !!date && isKnownDarkForSlot(showId, date, key);
    const selected = slot === key;
    const scheduleTime = date && !dark ? resolveShowtimeDefault(showId, date, key) : null;
    // The selected slot shows the SAVED time, so the sheet and the card
    // never disagree if the schedule moved after it was picked.
    const shownTime = selected && entry.curtain_time ? entry.curtain_time.slice(0, 5) : scheduleTime;
    return (
      <button
        type="button"
        disabled={!date || dark || saving}
        aria-pressed={selected}
        onClick={guarded(() => onShowtimeChange({ time_slot: key, curtain_time: `${scheduleTime}:00` }))}
        className={slotClass(selected, !date || dark)}
      >
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs mt-0.5 opacity-80">{dark ? 'Not playing' : shownTime ? formatTime(shownTime) : ' '}</span>
      </button>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="sm" bottomSheet ariaLabel={`Your plans for ${showTitle}`}>
      <div className="p-card-lg" data-testid="watchlist-plan-sheet">
        <div className="flex items-start justify-between gap-3 mb-5">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-white truncate">{showTitle}</h2>
            <p className="text-sm text-gray-400">On your watchlist</p>
          </div>
          <ModalCloseButton onClick={onClose} />
        </div>

        <p className="text-xs font-bold uppercase tracking-[0.12em] text-gray-500 mb-2">Date</p>
        <DatePickerButton
          value={date || ''}
          onChange={(val) => { guarded(() => onDateChange(val || null))(); }}
          onClear={date ? () => { guarded(() => onDateChange(null))(); } : undefined}
          ariaLabel="Planned date"
          disabled={saving}
          className="w-full h-12 pl-4 pr-10 rounded-xl bg-white/[0.06] ring-1 ring-inset ring-white/10 hover:bg-white/10 flex items-center gap-3 text-left text-base text-white transition-colors"
        >
          <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className={date ? '' : 'text-gray-400'}>
            {date
              ? new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              : 'Pick a date'}
          </span>
        </DatePickerButton>

        <p className="text-xs font-bold uppercase tracking-[0.12em] text-gray-500 mt-5 mb-2">Showtime</p>
        <div className={`grid grid-cols-3 gap-2 ${saving ? 'opacity-60' : ''}`}>
          {slotButton('matinee', 'Matinee')}
          {slotButton('evening', 'Evening')}
          <DatePickerButton
            type="time"
            value={slot === 'custom' && entry.curtain_time ? entry.curtain_time.slice(0, 5) : ''}
            onChange={(val) => { if (val && date) guarded(() => onShowtimeChange({ time_slot: 'custom', curtain_time: `${val}:00` }))(); }}
            ariaLabel={`Other showtime${slot === 'custom' ? ' (selected)' : ''}`}
            disabled={!date || saving}
            className={`w-full ${slotClass(slot === 'custom', !date)}`}
          >
            <span className="text-sm font-semibold">Other</span>
            <span className="text-xs mt-0.5 opacity-80">
              {slot === 'custom' && entry.curtain_time ? formatTime(entry.curtain_time.slice(0, 5)) : 'Pick time'}
            </span>
          </DatePickerButton>
        </div>
        {!date && <p className="text-xs text-gray-500 mt-2">Pick a date first, then choose a showtime.</p>}
        {slot && (
          <button
            type="button"
            disabled={saving}
            onClick={guarded(() => onShowtimeChange({ time_slot: null, curtain_time: null }))}
            className="mt-2 h-11 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Clear showtime
          </button>
        )}

        <div className="mt-5 space-y-2 [&_[data-testid=add-to-calendar]]:w-full [&_[data-testid=add-to-calendar]]:h-12">
          <AddToCalendarButtons event={event} />
          <button
            type="button"
            disabled={saving}
            onClick={async () => { await guarded(onRemove)(); onClose(); }}
            className="btn btn-secondary w-full h-12 text-score-skip"
          >
            Remove from watchlist
          </button>
        </div>
      </div>
    </Modal>
  );
}

function slotClass(selected: boolean, disabled: boolean): string {
  const base = 'flex flex-col items-center justify-center h-16 rounded-xl ring-1 ring-inset transition-colors';
  if (disabled) return `${base} ring-white/5 text-gray-600 cursor-not-allowed`;
  return selected
    ? `${base} bg-brand/10 ring-brand text-brand`
    : `${base} bg-white/[0.06] ring-white/10 text-white hover:bg-white/10`;
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
