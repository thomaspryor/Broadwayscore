'use client';

import { useId } from 'react';

interface YearRangeSliderProps {
  min: number;
  max: number;
  /** Current range. null = not set yet (full range implied). */
  value: { from: number; to: number } | null;
  onChange: (range: { from: number; to: number }) => void;
  /** Optional reset to "no range" */
  onClear?: () => void;
}

/**
 * Dual-handle year-range slider. Two stacked native <input type="range">
 * elements with z-index trickery — the active thumb tracks the front layer
 * so both handles remain operable. Emits {from, to} on each commit.
 */
export function YearRangeSlider({ min, max, value, onChange, onClear }: YearRangeSliderProps) {
  const fromId = useId();
  const toId = useId();
  const from = value?.from ?? min;
  const to = value?.to ?? max;
  const range = max - min || 1;
  const fromPct = ((from - min) / range) * 100;
  const toPct = ((to - min) / range) * 100;

  const handleFrom = (n: number) => {
    const next = Math.min(n, to);
    onChange({ from: next, to });
  };
  const handleTo = (n: number) => {
    const next = Math.max(n, from);
    onChange({ from, to: next });
  };

  return (
    <div className="pt-1">
      <div className="flex items-center gap-3">
        <span className="bg-surface-overlay border border-white/10 text-gray-100 text-xs font-bold tabular-nums px-2 py-1 rounded-md min-w-[44px] text-center">
          {from}
        </span>
        <div className="relative flex-1 h-6 flex items-center">
          {/* Track background */}
          <div className="absolute inset-x-0 h-1 bg-surface-overlay rounded-full" />
          {/* Active fill between handles */}
          <div
            className="absolute h-1 bg-brand rounded-full shadow-[0_0_8px_rgba(212,165,116,0.4)]"
            style={{ left: `${fromPct}%`, right: `${100 - toPct}%` }}
          />
          {/* Two stacked native ranges. Pointer-events on track only. */}
          <input
            id={fromId}
            type="range"
            min={min}
            max={max}
            value={from}
            onChange={(e) => handleFrom(parseInt(e.target.value, 10))}
            aria-label="Start year"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={from}
            className="absolute inset-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-brand [&::-webkit-slider-thumb]:shadow-md [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-brand"
            style={{ zIndex: from > max - (max - min) * 0.1 ? 4 : 3 }}
          />
          <input
            id={toId}
            type="range"
            min={min}
            max={max}
            value={to}
            onChange={(e) => handleTo(parseInt(e.target.value, 10))}
            aria-label="End year"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={to}
            className="absolute inset-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-brand [&::-webkit-slider-thumb]:shadow-md [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-brand"
            style={{ zIndex: 5 }}
          />
        </div>
        <span className="bg-surface-overlay border border-white/10 text-gray-100 text-xs font-bold tabular-nums px-2 py-1 rounded-md min-w-[44px] text-center">
          {to}
        </span>
      </div>
      <div className="flex items-center justify-between text-[10px] text-gray-500 tabular-nums mt-1 px-1">
        <span>{min}</span>
        {value && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-gray-400 hover:text-white underline underline-offset-2"
          >
            Clear range
          </button>
        )}
        <span>{max}</span>
      </div>
    </div>
  );
}
