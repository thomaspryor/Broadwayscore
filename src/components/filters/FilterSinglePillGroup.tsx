'use client';

interface SinglePillOption<T extends string> {
  value: T;
  label: string;
}

interface FilterSinglePillGroupProps<T extends string> {
  options: SinglePillOption<T>[];
  /** Currently-selected value */
  value: T;
  /** Set the selected value */
  onChange: (value: T) => void;
  ariaLabel?: string;
}

/**
 * Single-select pill row. Visually matches FilterPillGroup but only one
 * option may be selected at a time. Used inside the advanced filter panel
 * to mirror inline ToggleBars (Type, Status) as full panel members.
 */
export function FilterSinglePillGroup<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: FilterSinglePillGroupProps<T>) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => {
        const isSelected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(opt.value)}
            className={`px-3 sm:px-4 py-2.5 sm:py-2 min-h-[44px] sm:min-h-0 text-xs sm:text-sm leading-none font-semibold inline-flex items-center justify-center rounded-full transition-all ${
              isSelected
                ? 'bg-brand/10 text-brand border border-brand/40'
                : 'bg-surface-overlay text-gray-300 border border-white/10 hover:text-white hover:border-white/20'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
