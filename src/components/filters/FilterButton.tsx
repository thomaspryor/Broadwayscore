'use client';

interface FilterButtonProps {
  activeCount: number;
  isOpen: boolean;
  onClick: () => void;
  controlsId?: string;
}

/**
 * Filter icon button intended to live inside the search bar (right side).
 * Shows a numeric badge when filters are applied.
 */
export function FilterButton({ activeCount, isOpen, onClick, controlsId }: FilterButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={isOpen}
      aria-controls={controlsId}
      aria-label={activeCount > 0 ? `Filters (${activeCount} active)` : 'Open filters'}
      className={`relative w-10 h-10 inline-flex items-center justify-center rounded-lg transition-colors ${
        isOpen || activeCount > 0
          ? 'text-brand'
          : 'text-gray-300 hover:text-white'
      }`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={activeCount > 0 || isOpen ? 2.4 : 2} strokeLinecap="round" className="w-5 h-5">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="7" y1="12" x2="17" y2="12" />
        <line x1="10" y1="18" x2="14" y2="18" />
      </svg>
      {activeCount > 0 && (
        <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 bg-brand text-gray-900 text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-surface-raised box-content tabular-nums">
          {activeCount}
        </span>
      )}
    </button>
  );
}
