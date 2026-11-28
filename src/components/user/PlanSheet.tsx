'use client';

// The "your plans" bottom sheet, split from WatchlistPlanCard so the show page's
// first-load JS carries only the tappable row (BRO-7486). Loaded on first tap.
import { useState } from 'react';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import DatePickerButton from './DatePickerButton';
import AddToCalendarButtons from './AddToCalendarButtons';
import { resolveShowtimeDefault, isKnownDarkForSlot } from '@/lib/data-showtimes';
import { formatTime } from '@/lib/calendar/format';
import type { WatchlistPlanCardProps } from './WatchlistPlanCard';

export default function PlanSheet({ showId, showTitle, entry, event, onDateChange, onShowtimeChange, onRemove, isOpen, onClose }: WatchlistPlanCardProps & {
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
            <p className="text-sm text-gray-400">On your To See list</p>
          </div>
          <ModalCloseButton onClick={onClose} />
        </div>

        <p className="text-xs font-bold uppercase tracking-[0.12em] text-fg-muted mb-2">Date</p>
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

        <p className="text-xs font-bold uppercase tracking-[0.12em] text-fg-muted mt-5 mb-2">Showtime</p>
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
        {!date && <p className="text-xs text-fg-muted mt-2">Pick a date first, then choose a showtime.</p>}
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

        {/* Every control above saves the moment it changes. The sheet had no
            button that said so, so owners hunted for "Save" and closed with the
            X (owner, 2026-11-12). Done is the one primary action. */}
        <div className="mt-5 space-y-1">
          <button
            type="button"
            onClick={onClose}
            data-testid="watchlist-plan-done"
            className="btn btn-primary w-full h-12"
          >
            {saving ? 'Saving…' : 'Done'}
          </button>
          <p className="text-xs text-fg-muted text-center">Changes save automatically.</p>
          {/* Done is the only filled button. Calendar and Remove are quiet
              44px text actions (owner, 2026-11-12: "just one main CTA"). */}
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <AddToCalendarButtons event={event} quiet />
            <button
              type="button"
              disabled={saving}
              onClick={async () => { await guarded(onRemove)(); onClose(); }}
              className="focus-ring rounded-lg h-11 px-3 text-sm font-semibold text-score-skip hover:underline disabled:opacity-60"
            >
              Remove from To See
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function slotClass(selected: boolean, disabled: boolean): string {
  const base = 'flex flex-col items-center justify-center h-16 rounded-xl ring-1 ring-inset transition-colors';
  if (disabled) return `${base} ring-white/5 text-fg-muted opacity-60 cursor-not-allowed`;
  return selected
    ? `${base} bg-brand/10 ring-brand text-brand`
    : `${base} bg-white/[0.06] ring-white/10 text-white hover:bg-white/10`;
}
