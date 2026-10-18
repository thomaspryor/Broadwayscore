'use client';

import { useEffect, useCallback, useState, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useMyRating } from '@/hooks/useMyRating';
import { useToastSafe } from '@/components/ui/Toast';
import { getPendingAction, clearPendingAction } from '@/lib/deferred-auth';
import { useLocalWatchlist } from '@/hooks/useLocalWatchlist';
import { featureFlags } from '@/config/feature-flags';

interface ShowPageBookmarkProps {
  showId: string;
  /** 'sm' for card thumbnails, 'md' for show page poster (default), 'compact' for v2 mobile header */
  size?: 'sm' | 'md' | 'compact';
}

// ROOT CAUSE of the repeated "bookmark floats too far from the corner"
// regressions (owner, 2026-07-19/20/Oct-18): globals.css forces every <button>
// to min 44x44 on mobile (<=640px). This button's glyph box is only 28x32, so
// the svg sat centered inside a 44x44 button: +8px right, +6px top of extra
// gap that no top/right offset tuning accounted for (live measure: 11.5px top /
// 11.8px right). Offset-tweaking without measuring kept missing it.
// Fix: sm and compact opt out of the global minimum (min-h-0 min-w-0) so the
// button IS the svg box, then offsets are exact. The old 44x44 tap area comes
// back as an invisible ::after anchored to the top-right corner and growing
// 16px left and 12px down (28+16 x 32+12 = 44x44); a symmetric -inset-2 only
// gave ~36x40 once the thumbnail's overflow-hidden clipped it (review, Oct 2026).
// Glyph padding inside the 24-unit viewBox at w-7 h-8 (scale 1.167, content
// centered vertically): right 5.8px, top 5.5px. So top-0 right-0 gives a
// ~5.5-6px visual gap on both axes (owner: "half the current distance").
// tests/unit/bookmark-corner-gap.test.mjs pins this.
// md (show-page hero, legacy) keeps positive offsets: tuned against the 44px box.
const CORNER_BUTTON = "top-0 right-0 p-0 min-h-0 min-w-0 after:content-[''] after:absolute after:top-0 after:right-0 after:-left-4 after:-bottom-3";
const SIZES = {
  sm: { button: CORNER_BUTTON, icon: 'w-7 h-8' },
  md: { button: 'top-1 right-1 p-0', icon: 'w-8 h-9' },
  compact: { button: CORNER_BUTTON, icon: 'w-7 h-8' },
};

/**
 * Bookmark icon overlaid on show poster/thumbnail images.
 * Outline when not watchlisted, filled gold when watchlisted.
 * Place inside a `relative` container over the image.
 */
export default function ShowPageBookmark({ showId, size = 'md' }: ShowPageBookmarkProps) {
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const { isSavedLocally, toggleLocal } = useLocalWatchlist();
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
    // Until auth resolves we can't tell which list a tap belongs to.
    if (authLoading) return;
    // Signed out: save on this device now, offer sign-in after (BRO-4616).
    if (!isAuthenticated) {
      toggleLocal(showId, 'show_bookmark');
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
  }, [showId, isAuthenticated, authLoading, toggleLocal, isWatchlisted, addToWatchlist, removeFromWatchlist, showToast]);

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

  const watched = isAuthenticated ? isWatchlisted(showId) : isSavedLocally(showId);
  const s = SIZES[size];

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={loading}
      className={`absolute ${s.button} z-10 flex items-center justify-center rounded-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80 ${
        watched
          ? 'drop-shadow-md'
          : `${size === 'sm' ? 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100' : ''}`
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
