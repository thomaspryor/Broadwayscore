'use client';

import { YearRangeSlider } from './YearRangeSlider';
import {
  TONY_SEASONS,
  DECADES,
  SLIDER_MIN_YEAR,
  SLIDER_MAX_YEAR,
  type DateRange,
  type RangeDef,
  rangesEqual,
  findSeason,
  findDecade,
  isAllSeasons,
  yearsToDateRange,
  dateRangeToYears,
} from '@/lib/tony-seasons';

interface TimePeriodSectionProps {
  dateRanges: DateRange[];
  /**
   * Accepts either a new array OR a function that receives the live URL
   * state (not React state) and returns the next array. The function form
   * is required for back-to-back season-pill toggles in the same tick —
   * see feedback_react_searchparams_stale.md.
   */
  onChange: (ranges: DateRange[] | ((prev: DateRange[]) => DateRange[])) => void;
}

/**
 * Three views over a single dateRanges array:
 *  - Recent season pills: MULTI-select, toggle in/out of array. Active when
 *    the array contains an exact match for that season window.
 *  - Decade pills: SINGLE-select, replace the array with one decade range.
 *  - Custom slider: SINGLE-select, replaces the array with one calendar
 *    range (Jan 1 → Dec 31).
 *
 * Multi-mix rule: clicking a season while the current selection is all
 * seasons (or empty) toggles within the multi-set. Clicking a season while
 * a decade or slider range is active replaces the array with that one
 * season. Predicate logic ORs every range — see TIME_PERIOD_RANGE.
 */
export function TimePeriodSection({ dateRanges, onChange }: TimePeriodSectionProps) {
  const containsRange = (def: RangeDef) => dateRanges.some((r) => rangesEqual(r, def));

  // Decade pill is "active" only when it's the SOLE selection
  const isDecadeActive = (def: RangeDef) =>
    dateRanges.length === 1 && rangesEqual(dateRanges[0], def);

  // Functional form so rapid back-to-back toggles in the same tick all see
  // the latest URL state (React state lags one render behind router.replace).
  const onSeasonPill = (def: RangeDef) => {
    onChange((prev) => {
      const has = prev.some((r) => rangesEqual(r, def));
      if (has) return prev.filter((r) => !rangesEqual(r, def));
      if (prev.length === 0 || isAllSeasons(prev)) {
        return [...prev, { from: def.from, to: def.to }];
      }
      return [{ from: def.from, to: def.to }];
    });
  };

  const onDecadePill = (def: RangeDef) => {
    if (isDecadeActive(def)) onChange([]);
    else onChange([{ from: def.from, to: def.to }]);
  };

  // Slider works in integer years; map to/from a single calendar-range entry.
  // Active slider range = the lone date-range when it's NOT a known season/decade.
  const sliderRange: { from: number; to: number } | null = (() => {
    if (dateRanges.length !== 1) return null;
    const r = dateRanges[0];
    if (findSeason(r) || findDecade(r)) return null;
    return dateRangeToYears(r);
  })();

  const onSliderChange = (range: { from: number; to: number }) => {
    onChange([yearsToDateRange(range.from, range.to)]);
  };

  return (
    <div className="space-y-3">
      <Sublabel>Recent seasons</Sublabel>
      <div className="flex flex-wrap items-center gap-2">
        {TONY_SEASONS.map((def) => (
          <Pill
            key={def.id}
            label={def.label}
            isSelected={containsRange(def)}
            onClick={() => onSeasonPill(def)}
          />
        ))}
      </div>

      <Sublabel>Decade</Sublabel>
      <div className="flex flex-wrap items-center gap-2">
        {DECADES.map((def) => (
          <Pill
            key={def.id}
            label={def.label}
            isSelected={isDecadeActive(def)}
            onClick={() => onDecadePill(def)}
          />
        ))}
      </div>

      <Sublabel>Custom range</Sublabel>
      <YearRangeSlider
        min={SLIDER_MIN_YEAR}
        max={SLIDER_MAX_YEAR}
        value={sliderRange}
        onChange={onSliderChange}
        onClear={() => onChange([])}
      />
    </div>
  );
}

function Sublabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
      {children}
    </div>
  );
}

function Pill({ label, isSelected, onClick }: { label: string; isSelected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      className={`px-3 sm:px-4 py-2.5 sm:py-2 min-h-[44px] sm:min-h-0 text-xs sm:text-sm leading-none font-semibold inline-flex items-center gap-1.5 justify-center rounded-full transition-all ${
        isSelected
          ? 'bg-brand/10 text-brand border border-brand/40'
          : 'bg-surface-overlay text-gray-300 border border-white/10 hover:text-white hover:border-white/20'
      }`}
    >
      {label}
      {isSelected && (
        <span className="w-3.5 h-3.5 rounded-full bg-brand text-gray-900 inline-flex items-center justify-center text-[10px] font-bold">
          ✓
        </span>
      )}
    </button>
  );
}
