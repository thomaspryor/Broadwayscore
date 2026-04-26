'use client';

import { YearRangeSlider } from './YearRangeSlider';

interface TimePeriodSectionProps {
  yearRange: { from: number; to: number } | null;
  onChange: (range: { from: number; to: number } | null) => void;
}

const MIN_YEAR = 1950;
const CURRENT_YEAR = new Date().getFullYear();

const RECENT_SEASONS: { year: number; label: string }[] = Array.from({ length: 8 }, (_, i) => {
  const year = CURRENT_YEAR - i;
  return { year, label: `${year}–${String((year + 1) % 100).padStart(2, '0')}` };
});

const DECADES: { id: string; label: string; from: number; to: number }[] = [
  { id: '2010s', label: '2010s', from: 2010, to: 2019 },
  { id: '2000s', label: '2000s', from: 2000, to: 2009 },
  { id: '1990s', label: '1990s', from: 1990, to: 1999 },
  { id: '1980s', label: '1980s', from: 1980, to: 1989 },
  { id: '1970s', label: '1970s', from: 1970, to: 1979 },
  { id: '1960s', label: '1960s', from: 1960, to: 1969 },
  { id: 'pre-1960', label: 'Pre-1960', from: 1950, to: 1959 },
];

/**
 * Three views over a single {from, to} year range:
 *  - Recent season pills: selected if range covers that single year
 *  - Decade pills: selected if range fully spans the decade (or is exactly that decade)
 *  - Custom slider: directly edits the range
 *
 * Tapping a pill SETS the range to that pill's bounds (not toggles within range).
 * This mirrors the simpler "pick one preset, then refine" mental model.
 */
export function TimePeriodSection({ yearRange, onChange }: TimePeriodSectionProps) {
  const isYearActive = (year: number) =>
    !!yearRange && yearRange.from === year && yearRange.to === year;
  const isDecadeActive = (from: number, to: number) =>
    !!yearRange && yearRange.from === from && yearRange.to === to;

  const onYearPill = (year: number) => {
    if (isYearActive(year)) onChange(null);
    else onChange({ from: year, to: year });
  };
  const onDecadePill = (from: number, to: number) => {
    if (isDecadeActive(from, to)) onChange(null);
    else onChange({ from, to });
  };

  return (
    <div className="space-y-3">
      <Sublabel>Recent seasons</Sublabel>
      <div className="flex flex-wrap items-center gap-2">
        {RECENT_SEASONS.map(({ year, label }) => (
          <Pill
            key={year}
            label={label}
            isSelected={isYearActive(year)}
            onClick={() => onYearPill(year)}
          />
        ))}
      </div>

      <Sublabel>Decade</Sublabel>
      <div className="flex flex-wrap items-center gap-2">
        {DECADES.map(({ id, label, from, to }) => (
          <Pill
            key={id}
            label={label}
            isSelected={isDecadeActive(from, to)}
            onClick={() => onDecadePill(from, to)}
          />
        ))}
      </div>

      <Sublabel>Custom range</Sublabel>
      <YearRangeSlider
        min={MIN_YEAR}
        max={CURRENT_YEAR}
        value={yearRange}
        onChange={(r) => onChange(r)}
        onClear={() => onChange(null)}
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
