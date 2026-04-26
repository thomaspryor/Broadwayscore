'use client';

import { useEffect, useId } from 'react';
import { useFocusTrap } from '@/lib/hooks/useFocusTrap';
import { FILTER_GROUPS } from './filter-ui-config';
import { FilterPillGroup } from './FilterPillGroup';
import { TimePeriodSection } from './TimePeriodSection';

interface FilterPanelProps {
  isOpen: boolean;
  onClose: () => void;
  selectedByGroup: Record<string, ReadonlySet<string>>;
  onToggle: (paramKey: string, id: string) => void;
  yearRange: { from: number; to: number } | null;
  onYearRangeChange: (range: { from: number; to: number } | null) => void;
  onClearAll: () => void;
  resultCount: number;
}

/**
 * Bottom-sheet on mobile (<640px), popover on desktop (>=640px).
 * Wraps focus, dismisses on Esc, applies live (no separate Apply button —
 * the bottom button shows the result count and acts as a confirm/close).
 */
export function FilterPanel({
  isOpen,
  onClose,
  selectedByGroup,
  onToggle,
  yearRange,
  onYearRangeChange,
  onClearAll,
  resultCount,
}: FilterPanelProps) {
  const headingId = useId();
  const containerRef = useFocusTrap<HTMLDivElement>(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    // Lock body scroll while open (mobile sheet)
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm sm:bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet (mobile) / Popover (desktop) */}
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className={[
          // Mobile: full-width bottom sheet
          'fixed bottom-0 left-0 right-0 z-50 max-h-[78vh] flex flex-col',
          'bg-surface-raised border-t border-white/10 rounded-t-2xl shadow-[0_-10px_40px_rgba(0,0,0,0.5)]',
          // Desktop: centered popover
          'sm:bottom-auto sm:top-24 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:w-[420px] sm:max-h-[80vh] sm:rounded-2xl sm:border sm:shadow-2xl',
          'animate-in slide-in-from-bottom-4 sm:slide-in-from-top-2 duration-200',
        ].join(' ')}
      >
        {/* Drag handle (mobile) */}
        <div className="sm:hidden w-9 h-1 bg-white/15 rounded-full mx-auto mt-2 mb-1 flex-shrink-0" aria-hidden="true" />

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5 flex-shrink-0">
          <h2 id={headingId} className="text-base font-bold text-white">Filters</h2>
          <button
            type="button"
            onClick={onClearAll}
            className="text-sm text-gray-400 hover:text-white"
          >
            Reset
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-2">
          {FILTER_GROUPS.map((group, idx) => (
            <div key={group.paramKey}>
              <div className="py-3 border-b border-white/5">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-2.5">
                  {group.label}
                </h3>
                <FilterPillGroup
                  options={group.options.map((o) => ({ value: o.id, label: o.label }))}
                  selected={selectedByGroup[group.paramKey] ?? new Set()}
                  onToggle={(id) => onToggle(group.paramKey, id)}
                  ariaLabel={`${group.label} filters`}
                />
              </div>
              {/* Insert Time period after Production (idx 0) */}
              {idx === 0 && (
                <div className="py-3 border-b border-white/5">
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-2.5">
                    Time period
                  </h3>
                  <TimePeriodSection yearRange={yearRange} onChange={onYearRangeChange} />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-5 py-3 border-t border-white/5 bg-surface-raised">
          <button
            type="button"
            onClick={onClose}
            className="w-full bg-brand text-gray-900 font-bold py-3.5 rounded-xl text-sm tracking-wide shadow-glow-sm hover:bg-brand-hover transition-colors"
          >
            Show {resultCount} {resultCount === 1 ? 'show' : 'shows'}
          </button>
        </div>
      </div>
    </>
  );
}
