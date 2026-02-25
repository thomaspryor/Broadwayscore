'use client';

interface ScoreToggleProps {
  value: 'critics' | 'audience';
  onChange: (value: 'critics' | 'audience') => void;
  /** Show Audience button first (e.g. NVP page) */
  audienceFirst?: boolean;
  /** 'large' uses wider padding (NVP page) */
  size?: 'default' | 'large';
  ariaLabel?: string;
  className?: string;
}

export function ScoreToggle({
  value,
  onChange,
  audienceFirst = false,
  size = 'default',
  ariaLabel = 'Score display mode',
  className,
}: ScoreToggleProps) {
  const items: { key: 'critics' | 'audience'; label: string }[] = audienceFirst
    ? [{ key: 'audience', label: 'Audience' }, { key: 'critics', label: 'Critics' }]
    : [{ key: 'critics', label: 'Critics' }, { key: 'audience', label: 'Audience' }];

  const btnClass = size === 'large'
    ? 'px-2.5 py-1.5 sm:px-4 sm:py-2 rounded-md text-[11px] sm:text-xs leading-none font-bold uppercase tracking-wider transition-all min-h-[44px] sm:min-h-0 inline-flex items-center justify-center'
    : 'px-2 py-1.5 sm:px-3 sm:py-2 rounded-md text-[10px] sm:text-xs leading-none font-bold uppercase tracking-wider transition-all min-h-[44px] sm:min-h-0 inline-flex items-center justify-center';

  return (
    <div
      className={`flex items-center gap-0 bg-surface-overlay rounded-lg p-0.5 border border-white/10${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={ariaLabel}
    >
      {items.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          aria-pressed={value === key}
          className={`${btnClass} ${
            value === key
              ? 'bg-brand text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
