'use client';

import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import ShowPageRating from './ShowPageRating';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useToastSafe } from '@/components/ui/Toast';
import { savePendingAction, getPendingAction, clearPendingAction } from '@/lib/deferred-auth';
import { supabaseRestInsert, supabaseRestUpdate } from '@/lib/supabase-rest';
import { featureFlags } from '@/config/feature-flags';

interface ShowPageRatingConnectedProps {
  showId: string;
  showTitle: string;
  previewDate?: string | null;
  closingDate?: string | null;
}

/**
 * Connected wrapper for ShowPageRating.
 * Hooks into AuthContext and Supabase data hooks.
 * Used on the show page — the actual show/[slug]/page.tsx imports this.
 */
export default function ShowPageRatingConnected({
  showId,
  showTitle,
  previewDate,
  closingDate,
}: ShowPageRatingConnectedProps) {
  const { user, isAuthenticated, showSignIn } = useAuth();
  const { reviews, getReviewsForShow } = useUserReviews(user?.id || null);
  const { isWatchlisted, addToWatchlist, removeFromWatchlist, getWatchlist, updatePlannedDate, watchlist } = useWatchlist(user?.id || null);
  const searchParams = useSearchParams();

  const { showToast } = useToastSafe();
  const hasExecutedPending = useRef(false);
  const [autoEditLatest, setAutoEditLatest] = useState(false);
  // ?rate=1 from watchlist "Rate" link — auto-open the rating panel
  const [autoRate, setAutoRate] = useState(searchParams.get('rate') === '1');

  // Load data when authenticated
  useEffect(() => {
    if (isAuthenticated && user) {
      getReviewsForShow(showId);
      getWatchlist();
    }
  }, [isAuthenticated, user, showId, getReviewsForShow, getWatchlist]);

  const handleSaveReview = useCallback(async (data: {
    rating: number;
    reviewText: string | null;
    dateSeen: string | null;
    reviewId?: string;
  }): Promise<string | void> => {
    if (!user) {
      showToast?.('Please sign in to save ratings.', 'error');
      throw new Error('Not signed in');
    }

    try {
      // All DB calls use direct REST API with explicit auth headers.
      // This bypasses the Supabase JS client's internal token resolution
      // which can lose the auth token under certain timing conditions.
      if (data.reviewId) {
        // Update existing review
        const filters = `id=eq.${data.reviewId}&user_id=eq.${user.id}`;
        const { data: updated, error } = await supabaseRestUpdate<{ id: string }>('reviews', filters, {
          rating: data.rating,
          review_text: data.reviewText || null,
          date_seen: data.dateSeen || null,
          updated_at: new Date().toISOString(),
        });
        if (error) throw new Error(error.message);

        showToast?.(<>Updated in <a href="/my-shows" className="underline hover:text-white/90">Reviews</a></>, 'success');
        await getReviewsForShow(showId);
        return updated?.id;
      } else {
        // Insert new review
        const { data: inserted, error } = await supabaseRestInsert<{ id: string }>('reviews', {
          user_id: user.id,
          show_id: showId,
          rating: data.rating,
          review_text: data.reviewText || null,
          date_seen: data.dateSeen || null,
        });
        if (error) throw new Error(error.message);

        showToast?.(<>Added to <a href="/my-shows" className="underline hover:text-white/90">Reviews</a></>, 'success');
        await getReviewsForShow(showId);
        return inserted?.id;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Rating] handleSaveReview failed:', e);
      const detail = e instanceof Error ? e.message : 'Unknown error';
      showToast?.(`Save failed: ${detail}`, 'error');
      throw new Error('Save failed');
    }
  }, [showId, user, getReviewsForShow, showToast]);

  // Execute pending action after auth (deferred auth flow)
  // IMPORTANT: Uses direct REST API instead of saveReview hook
  // because the hook's userId closure may still be null right after auth.
  useEffect(() => {
    if (!isAuthenticated || !user || hasExecutedPending.current) return;
    const pending = getPendingAction();
    if (!pending || pending.showId !== showId) return;

    hasExecutedPending.current = true;
    clearPendingAction();

    if (pending.type === 'rating' && pending.rating) {
      // Save via direct REST API with explicit auth headers
      (async () => {
        try {
          // Profile is ensured by AuthContext.ensureProfile() — no upsert here
          // (previous upsert was clobbering Google profile metadata)

          const { error: insertErr } = await supabaseRestInsert('reviews', {
            user_id: user.id,
            show_id: showId,
            rating: pending.rating,
            review_text: null,
            date_seen: null,
          });
          if (insertErr) throw new Error(insertErr.message);

          showToast?.(<>Added to <a href="/my-shows" className="underline hover:text-white/90">Reviews</a> — add date &amp; notes below</>, 'success');
          await getReviewsForShow(showId);
          setAutoEditLatest(true);
        } catch (e: unknown) {
          // eslint-disable-next-line no-console
          console.error('[Rating] Deferred save failed:', e);
          const detail = (e && typeof e === 'object' && 'message' in e) ? String((e as { message: string }).message) : 'Unknown error';
          showToast?.(`Save failed: ${detail}`, 'error');
        }
      })();
    } else if (pending.type === 'watchlist') {
      addToWatchlist(showId).then(() => {
        getWatchlist();
        showToast?.(<>Added to <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'success');
      }).catch(() => {
        showToast?.('Failed to add to watchlist.', 'error');
      });
    } else {
      showToast?.('Signed in successfully!', 'success');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user, showId]);

  const handleToggleWatchlist = useCallback(async () => {
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
    }
  }, [showId, isWatchlisted, addToWatchlist, removeFromWatchlist, showToast]);

  const handleUpdateWatchlistDate = useCallback(async (date: string | null) => {
    try {
      await updatePlannedDate(showId, date);
    } catch {
      showToast?.('Failed to save date.', 'error');
    }
  }, [showId, updatePlannedDate, showToast]);

  const handleAuthRequired = useCallback((context: 'rating' | 'watchlist', pendingRating?: number) => {
    // Save pending action for deferred auth (include rating if provided)
    savePendingAction({
      type: context,
      showId,
      ...(pendingRating != null && { rating: pendingRating }),
      returnUrl: window.location.pathname,
      timestamp: Date.now(),
    });
    showSignIn(context);
  }, [showId, showSignIn]);

  // Filter reviews for this show
  const showReviews = reviews.filter(r => r.show_id === showId);

  // Feature flag check — AFTER all hooks (React rules-of-hooks)
  if (!featureFlags.userAccounts) return null;

  const watchlistEntry = watchlist.find(w => w.show_id === showId);

  return (
    <ShowPageRating
      showId={showId}
      showTitle={showTitle}
      previewDate={previewDate}
      closingDate={closingDate}
      reviews={showReviews}
      isWatchlisted={isWatchlisted(showId)}
      watchlistDate={watchlistEntry?.planned_date || null}
      onSaveReview={handleSaveReview}
      onToggleWatchlist={handleToggleWatchlist}
      onUpdateWatchlistDate={handleUpdateWatchlistDate}
      onAuthRequired={handleAuthRequired}
      isAuthenticated={isAuthenticated}
      autoEditLatest={autoEditLatest}
      autoRate={autoRate}
      onAutoRateConsumed={() => setAutoRate(false)}
    />
  );
}
