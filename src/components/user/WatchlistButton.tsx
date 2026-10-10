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
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all duration-200 ${
        isWatchlisted
          ? 'bg-brand/10 border-brand text-brand hover:bg-brand/20'
          : 'bg-surface-overlay border-white/10 text-gray-300 hover:text-white hover:bg-white/10'
      } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      aria-label={isWatchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      {loading ? (
        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={isWatchlisted ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
        </svg>
      )}
      <span>{isWatchlisted ? 'Watchlisted' : 'Watchlist'}</span>
    </button>
  );
}
