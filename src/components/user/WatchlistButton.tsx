'use client';

interface WatchlistButtonProps {
  isWatchlisted: boolean;
  onToggle: () => void;
  loading?: boolean;
}

export default function WatchlistButton({ isWatchlisted, onToggle, loading = false }: WatchlistButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-full border transition-all duration-200 ${
        isWatchlisted
          ? 'bg-[#FFD700]/10 border-[#FFD700]/30 text-[#FFD700] hover:bg-[#FFD700]/20'
          : 'bg-white/[0.03] border-white/10 text-gray-400 hover:text-white hover:border-white/20'
      } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      aria-label={isWatchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      {loading ? (
        <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : isWatchlisted ? (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
        </svg>
      ) : (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" d="M12 5v14M5 12h14" />
        </svg>
      )}
      <span>{isWatchlisted ? 'Watchlisted' : 'Watchlist'}</span>
    </button>
  );
}
