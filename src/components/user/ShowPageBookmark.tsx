'use client';

import { useEffect, useCallback, useState, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useMyRating } from '@/hooks/useMyRating';
import { useToastSafe } from '@/components/ui/Toast';
import { savePendingAction, getPendingAction, clearPendingAction } from '@/lib/deferred-auth';
import { featureFlags } from '@/config/feature-flags';

interface ShowPageBookmarkProps {
  showId: string;
  /** 'sm' for card thumbnails, 'md' for show page poster (default), 'compact' for v2 mobile header */
  size?: 'sm' | 'md' | 'compact';
}

const SIZES = {
  sm: { button: 'top-0.5 right-0.5 p-0', icon: 'w-7 h-8' },
  md: { button: 'top-1 right-1 p-0', icon: 'w-8 h-9' },
  compact: { button: 'top-0.5 right-0.5 p-0', icon: 'w-7 h-8' },
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
  const myRating = useMyRating(user?.id || null, showId);

  useEffect(() => {
    if (isAuthenticated && user) getWatchlist();
  }, [isAuthenticated, user, getWatchlist]);

  // Resume a deferred watchlist-add after sign-in ON ANY PAGE. Previously only
  // the show-page hero consumed 'watchlist' pendings, so a bookmark tapped on a
  // homepage/browse card was never completed after auth — and the stale pending
  // then fired silently on a later show-page visit (the "mystery watchlist
  // entry", 2026-07-12). Read-then-clear is synchronous, so with several
  // consumers mounted (hero + cards) the first effect wins and the rest see null.
  const resumedPending = useRef(false);
  useEffect(() => {
    if (!isAuthenticated || !user || resumedPending.current) return;
    const pending = getPendingAction();
    if (!pending || pending.type !== 'watchlist' || pending.showId !== showId) return;
    resumedPending.current = true;
    clearPendingAction();
    addToWatchlist(showId)
      .then(() => showToast?.(<>Added to <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'success'))
      .catch(() => showToast?.('Failed to add to watchlist.', 'error'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user, showId]);

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

  // Rated = seen: the corner slot shows YOUR star rating instead of the
  // bookmark (owner pick 4B, 2026-07-12). One slot, three states:
  // empty bookmark → nothing yet · filled bookmark → want to see · ★ → seen.
  if (myRating !== null) {
    return (
      <div
        className={`absolute top-1 right-1 z-10 pointer-events-none flex items-center gap-0.5 rounded-full bg-surface/90 border border-amber-400/30 font-bold text-[#FFD700] ${size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-0.5 text-xs'}`}
        aria-label={`Your rating: ${myRating.toFixed(1)} stars`}
        role="img"
      >
        <span aria-hidden="true">★</span>
        <span className="tabular-nums">{myRating.toFixed(1)}</span>
      </div>
    );
  }

  const watched = isWatchlisted(showId);
  const s = SIZES[size];

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={loading}
      className={`absolute ${s.button} z-10 flex items-center justify-center transition-all ${
        watched
          ? 'drop-shadow-md'
          : `${size === 'sm' ? 'sm:opacity-0 sm:group-hover:opacity-100' : ''}`
      } ${loading ? 'opacity-50' : ''}`}
      aria-label={watched ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      <svg className={`${s.icon} drop-shadow-lg`} viewBox="0 0 24 24">
        <path
          d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
          // Brand gold (tailwind `brand` / `accent.gold`), not generic amber —
          // owner flagged the off-palette #f59e0b as foreign (2026-07-14).
          fill={watched ? '#d4a574' : 'rgba(0,0,0,0.55)'}
          stroke={watched ? '#e4b584' : 'rgba(255,255,255,0.75)'}
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
