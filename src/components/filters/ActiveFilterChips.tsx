'use client';

export interface ActiveFilterChip {
  /** Stable key — typically the predicate id */
  key: string;
  label: string;
}

interface ActiveFilterChipsProps {
  chips: ActiveFilterChip[];
  onRemove: (key: string) => void;
  onClearAll: () => void;
}

/**
 * Horizontal chip row shown below the search bar when any panel filter
 * is active. Each chip removes its filter; "Clear all" removes all panel
 * filters (existing inline filters — Status/Sort/Type — untouched).
 */
export function ActiveFilterChips({ chips, onRemove, onClearAll }: ActiveFilterChipsProps) {
  if (chips.length === 0) return null;

  return (
    <div
      className="flex items-center gap-1.5 px-1 pb-2 overflow-x-auto flex-nowrap scrollbar-hide [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent_100%)] sm:[mask-image:none]"
      role="group"
      aria-label="Active filters"
    >
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => onRemove(chip.key)}
          aria-label={`Remove ${chip.label}`}
          className="flex-shrink-0 inline-flex items-center gap-1 bg-brand/10 border border-brand/30 text-brand text-xs font-semibold pl-2.5 pr-1.5 py-1.5 rounded-full hover:bg-brand/20 transition-colors"
        >
          <span>{chip.label}</span>
          <svg viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2} fill="none" className="w-3 h-3">
            <path d="M2 2 L10 10 M10 2 L2 10" />
          </svg>
        </button>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="flex-shrink-0 ml-auto pl-2 text-xs text-gray-400 hover:text-white underline underline-offset-4"
      >
        Clear all
      </button>
    </div>
  );
}
