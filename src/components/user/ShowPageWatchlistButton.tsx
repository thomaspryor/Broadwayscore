'use client';

import { useEffect, useCallback, useState } from 'react';
import Link from 'next/link';
import WatchlistButton from './WatchlistButton';
import DatePickerButton from './DatePickerButton';
import { useAuth } from '@/contexts/AuthContext';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useToastSafe } from '@/components/ui/Toast';
import { savePendingAction } from '@/lib/deferred-auth';
import { featureFlags } from '@/config/feature-flags';

interface ShowPageWatchlistButtonProps {
  showId: string;
}

/**
 * Self-contained watchlist button for the show page links row.
 * Handles auth, toggle, planned date, and "See Watchlist" link.
 */
export default function ShowPageWatchlistButton({ showId }: ShowPageWatchlistButtonProps) {
  const { user, isAuthenticated, loading: authLoading, showSignIn } = useAuth();
  const { isWatchlisted, addToWatchlist, removeFromWatchlist, getWatchlist, updatePlannedDate, watchlist } = useWatchlist(user?.id || null);
  const { showToast } = useToastSafe();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated && user) {
      getWatchlist();
    }
  }, [isAuthenticated, user, getWatchlist]);

  const handleToggle = useCallback(async () => {
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
      showToast?.('Failed to update watchlist. Please try again.', 'error');
    } finally {
      setLoading(false);
    }
  }, [showId, isAuthenticated, authLoading, showSignIn, isWatchlisted, addToWatchlist, removeFromWatchlist, showToast]);

  if (!featureFlags.userAccounts) return null;

  const watched = isWatchlisted(showId);
  const watchlistEntry = watchlist.find(w => w.show_id === showId);
  const watchlistDate = watchlistEntry?.planned_date || null;

  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      {watched && (
        <DatePickerButton
          value={watchlistDate || ''}
          onChange={val => updatePlannedDate(showId, val || null).catch(() => showToast?.('Failed to save date.', 'error'))}
          ariaLabel="Planned date"
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors min-h-[36px] px-2 -mx-2"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>
            {watchlistDate
              ? new Date(watchlistDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              : 'Add date'}
          </span>
        </DatePickerButton>
      )}
      <WatchlistButton
        isWatchlisted={watched}
        onToggle={handleToggle}
        loading={loading}
      />
    </div>
  );
}
