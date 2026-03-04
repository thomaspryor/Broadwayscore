'use client';

import React, { useEffect, useCallback, useRef } from 'react';
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
  const { isWatchlisted, addToWatchlist, removeFromWatchlist, getWatchlist, updatePlannedDate, watchlist } = useWatchlist(user?.id || null);

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
  }): Promise<string | void> => {
    try {
      const client = getSupabaseClient();
      if (!client) {
        showToast?.('Not connected. Please refresh the page.', 'error');
        throw new Error('No Supabase client');
      }

      // Verify session is valid before saving
      const { data: sessionData } = await client.auth.getSession();
      if (!sessionData?.session) {
        showToast?.('Session expired. Please sign in again.', 'error');
        throw new Error('Session expired');
      }

      // Ensure profile exists before saving (foreign key requirement)
      if (user) {
        try {
          const { data: profileData } = await client
            .from('profiles')
            .select('id')
            .eq('id', user.id)
            .single();
          if (!profileData) {
            const meta = sessionData.session.user?.user_metadata || {};
            await client.from('profiles').upsert({
              id: user.id,
              display_name: meta.full_name || meta.name || '',
              avatar_url: meta.avatar_url || meta.picture || null,
            }, { onConflict: 'id' });
          }
        } catch (profileErr) {
          // eslint-disable-next-line no-console
          console.warn('[Rating] Profile ensure failed (non-fatal):', profileErr);
        }
      }

      const result = await saveReview({
        showId,
        rating: data.rating,
        reviewText: data.reviewText,
        dateSeen: data.dateSeen,
        reviewId: data.reviewId,
      });
      showToast?.(<>Added to <a href="/my-shows" className="underline hover:text-white/90">Reviews</a></>, 'success');
      await getReviewsForShow(showId);
      return result?.id;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Rating] handleSaveReview failed:', e);
      if (!(e instanceof Error && (e.message === 'No Supabase client' || e.message === 'Session expired'))) {
        const detail = e instanceof Error ? e.message : 'Unknown error';
        showToast?.(`Save failed: ${detail}`, 'error');
      }
      throw new Error('Save failed');
    }
  }, [showId, user, saveReview, getReviewsForShow, showToast]);

  // Execute pending action after auth (deferred auth flow)
  // IMPORTANT: Uses Supabase client directly instead of saveReview hook
  // because the hook's userId closure may still be null right after auth.
  useEffect(() => {
    if (!isAuthenticated || !user || hasExecutedPending.current) return;
    const pending = getPendingAction();
    if (!pending || pending.showId !== showId) return;

    hasExecutedPending.current = true;
    clearPendingAction();

    if (pending.type === 'rating' && pending.rating) {
      // Save directly via Supabase client to avoid stale hook closure
      (async () => {
        try {
          const client = getSupabaseClient();
          if (!client) throw new Error('No client');

          // Ensure profile exists (foreign key requirement)
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

          const { error: insertErr } = await client
            .from('reviews')
            .insert({
              user_id: user.id,
              show_id: showId,
              rating: pending.rating,
              review_text: null,
              date_seen: null,
            });
          if (insertErr) throw insertErr;

          showToast?.(<>Added to <a href="/my-shows" className="underline hover:text-white/90">Reviews</a></>, 'success');
          await getReviewsForShow(showId);
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
    />
  );
}
