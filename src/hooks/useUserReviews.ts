'use client';

import { useState, useCallback } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import { supabaseRestDelete } from '@/lib/supabase-rest';
import type { UserReview } from '@/types/user';

export function useUserReviews(userId: string | null) {
  const [reviews, setReviews] = useState<UserReview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getReviewsForShow = useCallback(async (showId: string): Promise<UserReview[]> => {
    const client = getSupabaseClient();
    if (!client || !userId) return [];

    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await client
        .from('reviews')
        .select('*')
        .eq('user_id', userId)
        .eq('show_id', showId)
        .order('created_at', { ascending: false });

      if (err) throw err;
      const result = (data || []) as UserReview[];
      setReviews(result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load reviews';
      setError(msg);
      return [];
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const getAllReviews = useCallback(async (): Promise<UserReview[]> => {
    const client = getSupabaseClient();
    if (!client || !userId) return [];

    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await client
        .from('reviews')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (err) throw err;
      const result = (data || []) as UserReview[];
      setReviews(result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load reviews';
      setError(msg);
      return [];
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // NOTE: the actual rating write lives in ShowHeroRedesign.handleSaveReview
  // (direct supabase-rest with explicit auth headers). This hook only reads and
  // deletes; a former saveReview() here was dead code — its rating_submitted
  // analytics never fired. The live save path now emits that event.

  const deleteReview = useCallback(async (reviewId: string): Promise<void> => {
    if (!userId) return;

    setError(null);
    try {
      const { error: err } = await supabaseRestDelete('reviews', `id=eq.${reviewId}&user_id=eq.${userId}`);
      if (err) throw new Error(err.message);

      // Remove from local state so UI updates immediately
      setReviews(prev => prev.filter(r => r.id !== reviewId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to delete review';
      setError(msg);
      throw e instanceof Error ? e : new Error(msg);
    }
  }, [userId]);

  return {
    reviews,
    loading,
    error,
    getReviewsForShow,
    getAllReviews,
    deleteReview,
  };
}
