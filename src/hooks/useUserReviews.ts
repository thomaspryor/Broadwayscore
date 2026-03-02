'use client';

import { useState, useCallback } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
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

  const saveReview = useCallback(async (data: {
    showId: string;
    rating: number;
    reviewText?: string | null;
    dateSeen?: string | null;
    reviewId?: string; // If editing existing
  }): Promise<UserReview | null> => {
    const client = getSupabaseClient();
    if (!client || !userId) return null;

    setError(null);
    try {
      if (data.reviewId) {
        // Update existing
        const { data: updated, error: err } = await client
          .from('reviews')
          .update({
            rating: data.rating,
            review_text: data.reviewText || null,
            date_seen: data.dateSeen || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', data.reviewId)
          .eq('user_id', userId)
          .select()
          .single();

        if (err) throw err;
        return updated as UserReview;
      } else {
        // Insert new
        const { data: inserted, error: err } = await client
          .from('reviews')
          .insert({
            user_id: userId,
            show_id: data.showId,
            rating: data.rating,
            review_text: data.reviewText || null,
            date_seen: data.dateSeen || null,
          })
          .select()
          .single();

        if (err) throw err;
        return inserted as UserReview;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save review';
      setError(msg);
      throw new Error(msg);
    }
  }, [userId]);

  const deleteReview = useCallback(async (reviewId: string): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    setError(null);
    try {
      const { error: err } = await client
        .from('reviews')
        .delete()
        .eq('id', reviewId)
        .eq('user_id', userId);

      if (err) throw err;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to delete review';
      setError(msg);
      throw new Error(msg);
    }
  }, [userId]);

  return {
    reviews,
    loading,
    error,
    getReviewsForShow,
    getAllReviews,
    saveReview,
    deleteReview,
  };
}
