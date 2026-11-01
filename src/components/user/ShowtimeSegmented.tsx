'use client';

import { useEffect, useRef, useState } from 'react';
import DatePickerButton from './DatePickerButton';
import {
  isKnownDarkForSlot,
  onlyPerformanceSlot,
  resolveShowtimeDefault,
  scheduledShowtime,
} from '@/lib/data-showtimes';
import { formatTime } from '@/lib/calendar/format';
import type { ShowtimeSeat, TimeSlot } from '@/lib/review-showtime';

type Value = Pick<ShowtimeSeat, 'time_slot' | 'curtain_time'>;

interface ShowtimeSegmentedProps {
  showId: string;
  /** YYYY-MM-DD. The control only makes sense for a picked date. */
  date: string;
  value: Value;
  onChange: (v: Value) => void;
  /**
   * Plans need a real clock time for the calendar, so they fall back to the
   * generic 2:00 / 7:00 PM. A diary entry is a record, so an uncovered date
   * saves the slot with no time rather than a guess.
   */
  genericFallback?: boolean;
  /** Pick the slot when the schedule shows only one performance on the first render too. */
  autoSelectOnMount?: boolean;
  disabled?: boolean;
}

/**
 * Time row of the log/plan form (BRO-6783, owner design ref 2026-11-01):
 * a two-segment [Matinee | Evening] control with no times on the segments,
 * a "More options…" link for a custom time, and the resolved time in small
 * text underneath so a schedule default is never a hidden guess.
 */
export default function ShowtimeSegmented({
  showId, date, value, onChange, genericFallback = false, autoSelectOnMount = false, disabled = false,
}: ShowtimeSegmentedProps) {
  const [moreOpen, setMoreOpen] = useState(value.time_slot === 'custom');
  const slot = value.time_slot;

  const timeFor = (s: 'matinee' | 'evening'): string | null =>
    genericFallback ? resolveShowtimeDefault(showId, date, s) : scheduledShowtime(showId, date, s);

  // A new date invalidates the old performance: re-pick (single-show day) or clear.
  // If the parent set a new value in the same update as the date (a plan's
  // date + time arriving together), that value wins.
  const firstRun = useRef(true);
  const valueAtLastDate = useRef(value);
  useEffect(() => {
    const isFirst = firstRun.current;
    firstRun.current = false;
    const parentSetBoth = !isFirst && (valueAtLastDate.current.time_slot !== value.time_slot
      || valueAtLastDate.current.curtain_time !== value.curtain_time);
    valueAtLastDate.current = value;
    if (parentSetBoth) return;
    if (isFirst && (!autoSelectOnMount || value.time_slot)) return;
    const only = date ? onlyPerformanceSlot(showId, date) : null;
    const next: Value = only
      ? { time_slot: only, curtain_time: toDbTime(timeFor(only)) }
      : { time_slot: null, curtain_time: null };
    if (next.time_slot !== value.time_slot || next.curtain_time !== value.curtain_time) onChange(next);
    if (!isFirst) setMoreOpen(false);
    // Only a date change should re-run this; value/onChange are read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, showId]);

  useEffect(() => { valueAtLastDate.current = value; }, [value]);

  const pick = (s: 'matinee' | 'evening') => {
    if (slot === s) { onChange({ time_slot: null, curtain_time: null }); return; }
    onChange({ time_slot: s, curtain_time: toDbTime(timeFor(s)) });
    setMoreOpen(false);
  };

  const segment = (s: 'matinee' | 'evening', label: string) => {
    const dark = !!date && isKnownDarkForSlot(showId, date, s);
    const selected = slot === s;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled || dark}
        onClick={() => pick(s)}
        data-testid={`showtime-${s}`}
        className={`flex-1 h-10 rounded-[10px] text-sm font-semibold transition-colors ${
          selected
            ? 'bg-white/[0.16] text-white shadow-sm'
            : dark
              ? 'text-fg-muted opacity-50 cursor-not-allowed line-through'
              : 'text-gray-300 hover:text-white'
        }`}
      >
        {label}
      </button>
    );
  };

  const caption = captionFor(showId, date, value);

  return (
    <div data-testid="showtime-segmented">
      <div role="radiogroup" aria-label="Which performance" className={`flex gap-1 p-1 rounded-xl bg-white/[0.06] ring-1 ring-inset ring-white/10 ${disabled ? 'opacity-60' : ''}`}>
        {segment('matinee', 'Matinee')}
        {segment('evening', 'Evening')}
      </div>
      <div className="flex items-center justify-between gap-3 mt-1.5 min-h-[20px]">
        <span className="text-xs text-fg-muted" data-testid="showtime-caption">{caption}</span>
        {moreOpen || slot === 'custom' ? (
          <DatePickerButton
            type="time"
            value={slot === 'custom' && value.curtain_time ? value.curtain_time.slice(0, 5) : ''}
            onChange={(v) => { if (v) onChange({ time_slot: 'custom', curtain_time: `${v}:00` }); }}
            ariaLabel="Pick a curtain time"
            disabled={disabled}
            wrapClassName="relative shrink-0"
            className="text-xs font-semibold text-brand hover:underline py-1"
          >
            {slot === 'custom' ? 'Change time' : 'Pick a time'}
          </DatePickerButton>
        ) : (
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            disabled={disabled}
            className="shrink-0 text-xs font-semibold text-brand hover:underline py-1"
            data-testid="showtime-more-options"
          >
            More options…
          </button>
        )}
      </div>
    </div>
  );
}

function toDbTime(hhmm: string | null): string | null {
  return hhmm ? `${hhmm}:00` : null;
}

function captionFor(showId: string, date: string, v: Value): string {
  const time = v.curtain_time ? formatTime(v.curtain_time.slice(0, 5)) : null;
  if (v.time_slot === 'custom') return time ? `Curtain ${time}` : 'Pick a time';
  if (v.time_slot === 'matinee' || v.time_slot === 'evening') {
    const fromSchedule = !!date && scheduledShowtime(showId, date, v.time_slot) === v.curtain_time?.slice(0, 5);
    if (!time) return 'Time not listed for that date';
    return fromSchedule ? `Curtain ${time}, from the schedule` : `Curtain ${time} (usual time)`;
  }
  const darkM = !!date && isKnownDarkForSlot(showId, date, 'matinee');
  const darkE = !!date && isKnownDarkForSlot(showId, date, 'evening');
  if (darkM && darkE) return 'No performance listed that day';
  if (darkM) return 'No matinee that day';
  if (darkE) return 'No evening show that day';
  return 'Optional';
}

export type { TimeSlot };
