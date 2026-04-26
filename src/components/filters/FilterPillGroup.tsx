'use client';

interface FilterPillOption<T extends string> {
  value: T;
  label: string;
}

interface FilterPillGroupProps<T extends string> {
  options: FilterPillOption<T>[];
  /** Currently-selected values (multi-select) */
  selected: ReadonlySet<T>;
  /** Toggle a single option */
  onToggle: (value: T) => void;
  ariaLabel?: string;
}

/**
 * Multi-select pill group. Visually matches ToggleBar variant="pill"
 * (src/components/show-cards/ToggleBar.tsx) but allows multiple
 * concurrent selections. Used inside the advanced filter panel.
 */
export function FilterPillGroup<T extends string>({ options, selected, onToggle, ariaLabel }: FilterPillGroupProps<T>) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const isSelected = selected.has(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onToggle(opt.value)}
            aria-pressed={isSelected}
            className={`px-3 sm:px-4 py-2.5 sm:py-2 min-h-[44px] sm:min-h-0 text-xs sm:text-sm leading-none font-semibold inline-flex items-center gap-1.5 justify-center rounded-full transition-all ${
              isSelected
                ? 'bg-brand/10 text-brand border border-brand/40'
                : 'bg-surface-overlay text-gray-300 border border-white/10 hover:text-white hover:border-white/20'
            }`}
          >
            {opt.label}
            {isSelected && (
              <span className="w-3.5 h-3.5 rounded-full bg-brand text-gray-900 inline-flex items-center justify-center text-[10px] font-bold">
                ✓
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
