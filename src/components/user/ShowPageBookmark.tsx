'use client';

import { useEffect, useCallback, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useToastSafe } from '@/components/ui/Toast';
import { savePendingAction } from '@/lib/deferred-auth';
import { featureFlags } from '@/config/feature-flags';

interface ShowPageBookmarkProps {
  showId: string;
  /** 'sm' for card thumbnails, 'md' for show page poster (default) */
  size?: 'sm' | 'md';
}

const SIZES = {
  sm: { button: 'w-6 h-6 top-1 right-1', icon: 'w-3 h-3' },
  md: { button: 'w-8 h-8 top-2 right-2', icon: 'w-4 h-4' },
};

/**
 * Bookmark icon overlaid on show poster/thumbnail images.
 * Outline when not watchlisted, filled gold when watchlisted.
 * Place inside a `relative` container over the image.
 */
export default function ShowPageBookmark({ showId, size = 'md' }: ShowPageBookmarkProps) {
  const { user, isAuthenticated, loading: authLoading, showSignIn } = useAuth();
  const { isWatchlisted, addToWatchlist, removeFromWatchlist, getWatchlist } = useWatchlist(user?.id || null);
  const { showToast } = useToastSafe();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated && user) getWatchlist();
  }, [isAuthenticated, user, getWatchlist]);

  const handleToggle = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isAuthenticated && !authLoading) {
      savePendingAction({
        type: 'watchlist',
        showId,
        returnUrl: window.location.pathname,
        timestamp: Date.now(),
      });
      showSignIn('watchlist');
      return;
    }
    setLoading(true);
    try {
      if (isWatchlisted(showId)) {
        await removeFromWatchlist(showId);
        showToast?.(<>Removed from <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'info');
      } else {
        await addToWatchlist(showId);
        showToast?.(<>Added to <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'success');
      }
    } catch {
      showToast?.('Failed to update watchlist.', 'error');
    } finally {
      setLoading(false);
    }
  }, [showId, isAuthenticated, authLoading, showSignIn, isWatchlisted, addToWatchlist, removeFromWatchlist, showToast]);

  if (!featureFlags.userAccounts) return null;

  const watched = isWatchlisted(showId);
  const s = SIZES[size];

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={loading}
      className={`absolute ${s.button} z-10 flex items-center justify-center rounded-full transition-all ${
        watched
          ? 'bg-black/60 text-amber-400 scale-100'
          : `bg-black/40 text-white/70 hover:text-white hover:bg-black/60${size === 'sm' ? ' sm:opacity-0 sm:group-hover:opacity-100' : ''}`
      } ${loading ? 'opacity-50' : ''}`}
      aria-label={watched ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      <svg className={s.icon} viewBox="0 0 24 24" fill={watched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
      </svg>
    </button>
  );
}
