'use client';

import { useEffect, useCallback } from 'react';
import ShowPageRating from './ShowPageRating';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useToastSafe } from '@/components/ui/Toast';
import { savePendingAction } from '@/lib/deferred-auth';
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
  }) => {
    try {
      await saveReview({
        showId,
        rating: data.rating,
        reviewText: data.reviewText,
        dateSeen: data.dateSeen,
      });
      showToast?.('Rating saved!', 'success');
      // Refresh reviews
      await getReviewsForShow(showId);
    } catch {
      showToast?.('Failed to save rating. Please try again.', 'error');
      throw new Error('Save failed');
    }
  }, [showId, saveReview, getReviewsForShow, showToast]);

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

  const handleAuthRequired = useCallback((context: 'rating' | 'watchlist') => {
    // Save pending action for deferred auth
    savePendingAction({
      type: context,
      showId,
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
