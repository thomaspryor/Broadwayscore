'use client';

interface ScoreToggleProps {
  value: 'critics' | 'audience';
  onChange: (value: 'critics' | 'audience') => void;
  ariaLabel?: string;
  className?: string;
}

export function ScoreToggle({
  value,
  onChange,
  ariaLabel = 'Score display mode',
  className,
}: ScoreToggleProps) {
  return (
    <div
      className={`flex items-center gap-0 bg-surface-overlay rounded-lg p-0.5 border border-white/10${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={ariaLabel}
    >
      {([
        { key: 'critics' as const, label: 'Critics' },
        { key: 'audience' as const, label: 'Audience' },
      ]).map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          aria-pressed={value === key}
          className={`px-2 py-1.5 sm:px-3 sm:py-2 rounded-md text-[10px] sm:text-xs font-bold uppercase tracking-wider transition-all min-h-[44px] sm:min-h-0 ${
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
