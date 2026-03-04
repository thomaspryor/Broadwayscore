'use client';

import { useEffect, useCallback, useRef } from 'react';
import ShowPageRating from './ShowPageRating';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useToastSafe } from '@/components/ui/Toast';
import { savePendingAction, getPendingAction, clearPendingAction } from '@/lib/deferred-auth';
import { getSupabaseClient } from '@/lib/supabase';
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
  const { reviews, getReviewsForShow, saveReview } = useUserReviews(user?.id || null);
  const { isWatchlisted, addToWatchlist, removeFromWatchlist, getWatchlist } = useWatchlist(user?.id || null);

  const { showToast } = useToastSafe();
  const hasExecutedPending = useRef(false);

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
  }) => {
    try {
      // Ensure profile exists before saving (foreign key requirement)
      if (user) {
        const client = getSupabaseClient();
        if (client) {
          const { data: profileData } = await client
            .from('profiles')
            .select('id')
            .eq('id', user.id)
            .single();
          if (!profileData) {
            const { data: { user: authUser } } = await client.auth.getUser();
            const meta = authUser?.user_metadata || {};
            await client.from('profiles').upsert({
              id: user.id,
              display_name: meta.full_name || meta.name || '',
              avatar_url: meta.avatar_url || meta.picture || null,
            }, { onConflict: 'id' });
          }
        }
      }

      // Use provided reviewId, or find existing review for this show (for edits)
      const existingReview = reviews.find(r => r.show_id === showId);
      const existingId = data.reviewId || existingReview?.id;

      await saveReview({
        showId,
        rating: data.rating,
        reviewText: data.reviewText,
        dateSeen: data.dateSeen,
        reviewId: existingId,
      });
      showToast?.('Rating saved!', 'success');
      await getReviewsForShow(showId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Rating] handleSaveReview failed:', e);
      showToast?.('Failed to save rating. Please try again.', 'error');
      throw new Error('Save failed');
    }
  }, [showId, user, reviews, saveReview, getReviewsForShow, showToast]);

  // Execute pending action after auth (deferred auth flow)
  useEffect(() => {
    if (!isAuthenticated || !user || hasExecutedPending.current) return;
    const pending = getPendingAction();
    if (!pending || pending.showId !== showId) return;

    hasExecutedPending.current = true;
    clearPendingAction();

    if (pending.type === 'rating' && pending.rating) {
      handleSaveReview({
        rating: pending.rating,
        reviewText: null,
        dateSeen: null,
      });
    } else if (pending.type === 'watchlist') {
      showToast?.('Signed in! Adding to watchlist...', 'success');
      addToWatchlist(showId).then(() => {
        getWatchlist();
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
        showToast?.('Removed from watchlist', 'info');
      } else {
        await addToWatchlist(showId);
        showToast?.('Added to watchlist!', 'success');
      }
    } catch {
      showToast?.('Failed to update watchlist. Please try again.', 'error');
    }
  }, [showId, isWatchlisted, addToWatchlist, removeFromWatchlist, showToast]);

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

  return (
    <ShowPageRating
      showId={showId}
      showTitle={showTitle}
      previewDate={previewDate}
      closingDate={closingDate}
      reviews={showReviews}
      isWatchlisted={isWatchlisted(showId)}
      onSaveReview={handleSaveReview}
      onToggleWatchlist={handleToggleWatchlist}
      onAuthRequired={handleAuthRequired}
      isAuthenticated={isAuthenticated}
    />
  );
}
