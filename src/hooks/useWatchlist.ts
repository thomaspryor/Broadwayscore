'use client';

import { useState, useCallback, useEffect } from 'react';
import { track } from '@vercel/analytics';
import { getSupabaseClient } from '@/lib/supabase';
import type { WatchlistEntry } from '@/types/user';

// Cross-instance sync: all useWatchlist hooks with the same userId share state
const WATCHLIST_SYNC = 'watchlist-sync';
function broadcastWatchlist(userId: string, entries: WatchlistEntry[]) {
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(WATCHLIST_SYNC, { detail: { userId, entries } }));
  }
}

export function useWatchlist(userId: string | null) {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Listen for sync events from other instances
  useEffect(() => {
    if (!userId) return;
    const handler = (e: Event) => {
      const { userId: eventUserId, entries } = (e as CustomEvent).detail;
      if (eventUserId === userId) setWatchlist(entries);
    };
    document.addEventListener(WATCHLIST_SYNC, handler);
    return () => document.removeEventListener(WATCHLIST_SYNC, handler);
  }, [userId]);

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
      broadcastWatchlist(userId, result);
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

      track('watchlist_add', { show_id: showId });

      // Optimistic update + broadcast to other instances
      setWatchlist(prev => {
        const next = [
          { id: crypto.randomUUID(), user_id: userId, show_id: showId, planned_date: null, created_at: new Date().toISOString() },
          ...prev,
        ];
        broadcastWatchlist(userId, next);
        return next;
      });
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

      track('watchlist_remove', { show_id: showId });

      // Optimistic update + broadcast to other instances
      setWatchlist(prev => {
        const next = prev.filter(w => w.show_id !== showId);
        broadcastWatchlist(userId, next);
        return next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to remove from watchlist';
      setError(msg);
      throw new Error(msg);
    }
  }, [userId]);

  const updatePlannedDate = useCallback(async (showId: string, plannedDate: string | null): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    setError(null);
    try {
      const { error: err } = await client
        .from('watchlist')
        .update({ planned_date: plannedDate })
        .eq('user_id', userId)
        .eq('show_id', showId);

      if (err) throw err;

      // Optimistic update + broadcast to other instances
      setWatchlist(prev => {
        const next = prev.map(w =>
          w.show_id === showId ? { ...w, planned_date: plannedDate } : w
        );
        broadcastWatchlist(userId, next);
        return next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to update date';
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
    updatePlannedDate,
  };
}
