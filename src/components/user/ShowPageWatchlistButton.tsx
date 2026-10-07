'use client';

import { useEffect, useCallback, useState } from 'react';
import Link from 'next/link';
import WatchlistButton from './WatchlistButton';
import WatchlistPlanCard from './WatchlistPlanCard';
import { buildPlannedShowEvent } from '@/lib/calendar-event';
import { useAuth } from '@/contexts/AuthContext';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useToastSafe } from '@/components/ui/Toast';
import { useLocalWatchlist } from '@/hooks/useLocalWatchlist';
import { featureFlags } from '@/config/feature-flags';

interface ShowPageWatchlistButtonProps {
  showId: string;
  /** Fields for the "Add to Calendar" event — optional so callers that only
   *  have a bare id (none currently) still render the toggle + date picker. */
  title?: string;
  slug?: string;
  diaryOnly?: boolean;
  category?: string | null;
  venue?: string | null;
  theaterAddress?: string | null;
  runtime?: string | null;
  runtimeMin?: number | null;
}

/**
 * Self-contained watchlist button for the show page links row.
 * Handles auth and the toggle; once watchlisted, WatchlistPlanCard below it
 * holds the date, showtime, calendar and remove (same card as ShowHeroRedesign).
 */
export default function ShowPageWatchlistButton({
  showId, title, slug, diaryOnly, category, venue, theaterAddress, runtime, runtimeMin,
}: ShowPageWatchlistButtonProps) {
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const { isSavedLocally, toggleLocal } = useLocalWatchlist();
  const { isWatchlisted, addToWatchlist, removeFromWatchlist, getWatchlist, updatePlannedDate, updatePerformance, watchlist } = useWatchlist(user?.id || null);
  const { showToast } = useToastSafe();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated && user) {
      getWatchlist();
    }
  }, [isAuthenticated, user, getWatchlist]);

  const handleToggle = useCallback(async () => {
    if (authLoading) return;
    // Signed out: save on this device now, offer sign-in after (BRO-4616).
    if (!isAuthenticated) {
      toggleLocal(showId, 'show_watchlist');
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
  }, [showId, isAuthenticated, authLoading, toggleLocal, isWatchlisted, addToWatchlist, removeFromWatchlist, showToast]);

  if (!featureFlags.userAccounts) return null;

  const watched = isAuthenticated ? isWatchlisted(showId) : isSavedLocally(showId);
  const watchlistEntry = watchlist.find(w => w.show_id === showId);

  const event = watchlistEntry
    ? buildPlannedShowEvent(
        { id: showId, title: title || showId, slug: slug || showId, diaryOnly, category, venue, theaterAddress, runtime, runtimeMin },
        watchlistEntry,
      )
    : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-shrink-0">
        <WatchlistButton
          isWatchlisted={watched}
          onToggle={handleToggle}
          loading={loading}
        />
      </div>
      {watched && watchlistEntry && (
        <WatchlistPlanCard
          showId={showId}
          showTitle={title || showId}
          entry={watchlistEntry}
          event={event}
          onDateChange={val => updatePlannedDate(showId, val).catch(() => showToast?.('Failed to save date.', 'error'))}
          onShowtimeChange={fields => updatePerformance(showId, fields).catch(() => showToast?.('Failed to save showtime.', 'error'))}
          onRemove={handleToggle}
        />
      )}
    </div>
  );
}
