'use client';

import { useState } from 'react';
import DatePickerButton from './DatePickerButton';
import { resolveShowtimeDefault, isKnownDarkForSlot } from '@/lib/data-showtimes';
import { formatTime } from '@/lib/calendar';
import type { WatchlistEntry } from '@/types/user';

type TimeFields = Pick<WatchlistEntry, 'time_slot' | 'curtain_time'>;

interface ShowtimePickerProps {
  showId: string;
  /** Planned date (YYYY-MM-DD) — the picker only renders once a caller has one. */
  date: string;
  timeSlot: WatchlistEntry['time_slot'];
  curtainTime: string | null;
  onSave: (fields: TimeFields) => void | Promise<void>;
  /** Force icon-only sizing at every width, for the ~100px My Shows grid
   *  card (narrow regardless of viewport — more grid columns, not more
   *  room per card). Omit this on wider surfaces: they get the icon row
   *  below `sm` and the full text-pill row at `sm` and up for free. */
  compact?: boolean;
}

/**
 * Tier 2/3 of the showtime picker: Matinee / Evening resolve a real curtain
 * time from the schedule (falling back to a generic convention — see
 * resolveShowtimeDefault); Custom reuses DatePickerButton's wheel-safe native
 * time input so the same 3 iOS bugs it was built to dodge (password-manager
 * autofill, iOS firing `change` before a pick, showPicker() no-op on touch)
 * don't need a second fix here. Tier 1 (the date itself) stays the existing
 * DatePickerButton at each call site — this control only appears once a date
 * is already set.
 *
 * Non-compact callers get BOTH layouts (CSS-toggled, not JS breakpoint
 * detection) — the full text-pill row overflowed the My Shows LIST item at
 * 390px, squeezing the show title down to "Gy…" (visual QA, 2026-08-17).
 */
export default function ShowtimePicker(props: ShowtimePickerProps) {
  const { showId, date, timeSlot, curtainTime, onSave, compact } = props;
  // Guards against rapid Matinee→Evening→Custom taps racing each other —
  // updatePerformance has no request sequencing, so 3 quick clicks fire 3
  // concurrent PATCHes and whichever resolves last wins, not whichever was
  // clicked last (ship-check finding, 2026-08-17). Blocking input for the
  // duration of one save is simpler and safer than sequencing at the hook
  // layer, which every other write in useWatchlist shares this same gap with.
  const [saving, setSaving] = useState(false);
  const guardedSave = async (fields: TimeFields) => {
    setSaving(true);
    try {
      await onSave(fields);
    } finally {
      setSaving(false);
    }
  };
  // "No data for this date" (common — bwayrush only covers a few weeks out)
  // must NOT be treated the same as "confirmed no performance" (e.g. the
  // near-universal dark Monday) — the former still gets a sensible generic
  // default, the latter must not silently fabricate a fake curtain time for
  // a show that isn't playing that day (ship-check finding, 2026-08-17).
  const darkMatinee = isKnownDarkForSlot(showId, date, 'matinee');
  const darkEvening = isKnownDarkForSlot(showId, date, 'evening');
  const pickSlot = (slot: 'matinee' | 'evening') => {
    if (slot === 'matinee' ? darkMatinee : darkEvening) return;
    const time = resolveShowtimeDefault(showId, date, slot);
    guardedSave({ time_slot: slot, curtain_time: `${time}:00` });
  };
  const clear = () => guardedSave({ time_slot: null, curtain_time: null });

  const compactPicker = (
    <CompactShowtimePicker
      timeSlot={timeSlot} curtainTime={curtainTime}
      onPick={pickSlot} onSave={guardedSave} onClear={clear}
      responsiveOnly={!compact} saving={saving}
      darkMatinee={darkMatinee} darkEvening={darkEvening}
    />
  );
  if (compact) return compactPicker;

  return (
    <>
      <FullShowtimePicker
        timeSlot={timeSlot} curtainTime={curtainTime}
        onPick={pickSlot} onSave={guardedSave} onClear={clear} saving={saving}
        darkMatinee={darkMatinee} darkEvening={darkEvening}
      />
      {compactPicker}
    </>
  );
}

function FullShowtimePicker({ timeSlot, curtainTime, onPick, onSave, onClear, saving, darkMatinee, darkEvening }: {
  timeSlot: WatchlistEntry['time_slot'];
  curtainTime: string | null;
  onPick: (slot: 'matinee' | 'evening') => void;
  onSave: (fields: TimeFields) => void | Promise<void>;
  onClear: () => void;
  saving: boolean;
  darkMatinee: boolean;
  darkEvening: boolean;
}) {
  const pillBase = 'px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors whitespace-nowrap';
  const pillClass = (active: boolean, dark: boolean) =>
    dark
      ? `${pillBase} text-gray-700 border-white/5 cursor-not-allowed line-through`
      : active
      ? `${pillBase} bg-amber-400/20 text-amber-300 border-amber-400/40`
      : `${pillBase} text-gray-500 hover:text-gray-300 border-white/10 hover:border-white/20`;

  const customLabel = timeSlot === 'custom' && curtainTime
    ? formatTime(curtainTime.slice(0, 5))
    : 'Custom';

  return (
    <div
      className={`hidden sm:flex items-center flex-wrap gap-1 transition-opacity ${saving ? 'opacity-50 pointer-events-none' : ''}`}
      // Scoped stopPropagation — these controls live inside link-wrapped
      // cards elsewhere in this feature; an unscoped one on the wrapping div
      // would also swallow clicks meant for other children.
      onClick={e => e.stopPropagation()}
    >
      <button type="button" disabled={darkMatinee} title={darkMatinee ? 'No matinee scheduled this day' : undefined} className={pillClass(timeSlot === 'matinee', darkMatinee)} onClick={(e) => { e.preventDefault(); onPick('matinee'); }}>
        Matinee
      </button>
      <button type="button" disabled={darkEvening} title={darkEvening ? 'No evening performance scheduled this day' : undefined} className={pillClass(timeSlot === 'evening', darkEvening)} onClick={(e) => { e.preventDefault(); onPick('evening'); }}>
        Evening
      </button>
      <DatePickerButton
        type="time"
        value={timeSlot === 'custom' && curtainTime ? curtainTime.slice(0, 5) : ''}
        onChange={(val) => { if (val) onSave({ time_slot: 'custom', curtain_time: `${val}:00` }); }}
        ariaLabel={`Custom showtime${timeSlot === 'custom' ? ' (selected)' : ''}`}
        wrapClassName="relative inline-block"
        className={pillClass(timeSlot === 'custom', false)}
      >
        {customLabel}
      </DatePickerButton>
      {timeSlot && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }}
          aria-label="Clear showtime"
          className="p-0.5 text-gray-600 hover:text-white transition-colors"
        >
          <ClearIcon />
        </button>
      )}
    </div>
  );
}

/** Icon-only row: sun (matinee) / moon (evening) / clock (custom) / clear. */
function CompactShowtimePicker({ timeSlot, curtainTime, onPick, onSave, onClear, responsiveOnly, saving, darkMatinee, darkEvening }: {
  timeSlot: WatchlistEntry['time_slot'];
  curtainTime: string | null;
  onPick: (slot: 'matinee' | 'evening') => void;
  onSave: (fields: TimeFields) => void | Promise<void>;
  onClear: () => void;
  /** Only shown below `sm` — the sibling FullShowtimePicker takes over at `sm`+. */
  responsiveOnly?: boolean;
  saving: boolean;
  darkMatinee: boolean;
  darkEvening: boolean;
}) {
  const iconBtn = (active: boolean, dark: boolean) =>
    `w-4 h-4 flex items-center justify-center rounded transition-colors ${
      dark ? 'text-gray-700 cursor-not-allowed' : active ? 'bg-amber-400/20 text-amber-300' : 'text-gray-500 hover:text-gray-300'
    }`;
  const timeLabel = curtainTime
    ? formatTime(curtainTime.slice(0, 5))
    : timeSlot === 'matinee' ? 'Matinee' : timeSlot === 'evening' ? 'Evening' : timeSlot === 'custom' ? 'Custom time' : 'Set showtime';

  return (
    <div
      className={`showtime-compact flex items-center gap-0.5 mt-1 transition-opacity ${responsiveOnly ? 'sm:hidden' : ''} ${saving ? 'opacity-50 pointer-events-none' : ''}`}
      onClick={e => e.stopPropagation()}
    >
      <button type="button" disabled={darkMatinee} className={iconBtn(timeSlot === 'matinee', darkMatinee)} onClick={(e) => { e.preventDefault(); onPick('matinee'); }} aria-label={darkMatinee ? 'Matinee (none scheduled this day)' : `Matinee${timeSlot === 'matinee' ? ' (selected)' : ''}`} title={darkMatinee ? 'No matinee scheduled this day' : `Matinee${timeSlot === 'matinee' && curtainTime ? ` — ${timeLabel}` : ''}`}>
        <SunIcon />
      </button>
      <button type="button" disabled={darkEvening} className={iconBtn(timeSlot === 'evening', darkEvening)} onClick={(e) => { e.preventDefault(); onPick('evening'); }} aria-label={darkEvening ? 'Evening (none scheduled this day)' : `Evening${timeSlot === 'evening' ? ' (selected)' : ''}`} title={darkEvening ? 'No evening performance scheduled this day' : `Evening${timeSlot === 'evening' && curtainTime ? ` — ${timeLabel}` : ''}`}>
        <MoonIcon />
      </button>
      <DatePickerButton
        type="time"
        value={timeSlot === 'custom' && curtainTime ? curtainTime.slice(0, 5) : ''}
        onChange={(val) => { if (val) onSave({ time_slot: 'custom', curtain_time: `${val}:00` }); }}
        ariaLabel={`Custom showtime${timeSlot === 'custom' ? ` (selected${curtainTime ? ` — ${timeLabel}` : ''})` : ''}`}
        wrapClassName="relative inline-block"
        className={iconBtn(timeSlot === 'custom', false)}
      >
        <ClockIcon />
      </DatePickerButton>
      {timeSlot && (
        <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }} aria-label={`Clear showtime (${timeLabel})`} className={iconBtn(false, false)}>
          <ClearIcon />
        </button>
      )}
    </div>
  );
}

function SunIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="4" />
      <path strokeLinecap="round" d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 3" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
