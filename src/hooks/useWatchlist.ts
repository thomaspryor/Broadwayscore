'use client';

import { useState, useCallback } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import type { WatchlistEntry } from '@/types/user';

export function useWatchlist(userId: string | null) {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getWatchlist = useCallback(async (): Promise<WatchlistEntry[]> => {
    const client = getSupabaseClient();
    if (!client || !userId) return [];

    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await client
        .from('watchlist')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (err) throw err;
      const result = (data || []) as WatchlistEntry[];
      setWatchlist(result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load watchlist';
      setError(msg);
      return [];
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const isWatchlisted = useCallback((showId: string): boolean => {
    return watchlist.some(w => w.show_id === showId);
  }, [watchlist]);

  const addToWatchlist = useCallback(async (showId: string): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    setError(null);
    try {
      const { error: err } = await client
        .from('watchlist')
        .insert({ user_id: userId, show_id: showId });

      if (err) throw err;

      // Optimistic update
      setWatchlist(prev => [
        { id: crypto.randomUUID(), user_id: userId, show_id: showId, created_at: new Date().toISOString() },
        ...prev,
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to add to watchlist';
      setError(msg);
      throw new Error(msg);
    }
  }, [userId]);

  const removeFromWatchlist = useCallback(async (showId: string): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    setError(null);
    try {
      const { error: err } = await client
        .from('watchlist')
        .delete()
        .eq('user_id', userId)
        .eq('show_id', showId);

      if (err) throw err;

      // Optimistic update
      setWatchlist(prev => prev.filter(w => w.show_id !== showId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to remove from watchlist';
      setError(msg);
      throw new Error(msg);
    }
  }, [userId]);

  return {
    watchlist,
    loading,
    error,
    getWatchlist,
    isWatchlisted,
    addToWatchlist,
    removeFromWatchlist,
  };
}
