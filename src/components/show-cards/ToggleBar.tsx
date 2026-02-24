'use client';

interface ToggleBarOption<T extends string> {
  value: T;
  label: string;
}

interface ToggleBarProps<T extends string> {
  label?: string;
  options: ToggleBarOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  /** 'default' has 36px mobile tap targets; 'compact' for dense pages (critics, outlets) */
  size?: 'default' | 'compact';
  /** 'default' = text-style toggle; 'pill' = filled pill buttons (type filters) */
  variant?: 'default' | 'pill';
  className?: string;
}

export function ToggleBar<T extends string>({
  label,
  options,
  value,
  onChange,
  ariaLabel,
  size = 'default',
  variant = 'default',
  className,
}: ToggleBarProps<T>) {
  if (variant === 'pill') {
    const pillSize = size === 'compact'
      ? 'px-3 py-1.5 min-h-[36px] text-xs font-semibold uppercase tracking-wider'
      : 'px-3 sm:px-4 py-2.5 sm:py-2 min-h-[44px] sm:min-h-0 text-xs sm:text-sm font-semibold';
    return (
      <div
        className={`flex items-center gap-2${className ? ` ${className}` : ''}`}
        role="group"
        aria-label={ariaLabel ?? (label ? `${label} options` : 'Toggle options')}
      >
        {options.map((option) => (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={`${pillSize} rounded-full transition-all ${
              value === option.value
                ? 'bg-brand text-gray-900 shadow-glow-sm'
                : 'bg-surface-raised text-gray-400 border border-white/10 hover:text-white hover:border-white/20'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  const btnSize = size === 'compact'
    ? 'px-2 py-1'
    : 'px-2 py-1.5 sm:px-2 sm:py-1 min-h-[36px] sm:min-h-0';
  return (
    <div
      className={`flex items-center gap-0.5 sm:gap-2 flex-wrap${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={ariaLabel ?? (label ? `${label} options` : 'Toggle options')}
    >
      {label && (
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">
          {label}
        </span>
      )}
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`${btnSize} rounded text-[11px] font-medium uppercase tracking-wider transition-colors whitespace-nowrap ${
            value === option.value
              ? 'text-brand bg-brand/10 sm:bg-transparent'
              : 'text-gray-300 hover:text-white'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
