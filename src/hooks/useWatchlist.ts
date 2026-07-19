'use client';

import { useState, useCallback, useEffect } from 'react';
import { track } from '@vercel/analytics';
import { getSupabaseClient } from '@/lib/supabase';
import { supabaseRestInsert, supabaseRestDelete, supabaseRestUpdate } from '@/lib/supabase-rest';
import type { WatchlistEntry } from '@/types/user';

// Cross-instance sync: all useWatchlist hooks with the same userId share state
const WATCHLIST_SYNC = 'watchlist-sync';
function broadcastWatchlist(userId: string, entries: WatchlistEntry[]) {
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(WATCHLIST_SYNC, { detail: { userId, entries } }));
  }
}

// Shared in-flight fetch. A browse page renders ~30 poster cards, each a
// ShowPageBookmark that calls getWatchlist() on mount — without this cache that
// is ~30 identical watchlist GETs per page view for every signed-in user. All
// instances share ONE promise instead. Mirrors useMyRating's module cache.
// (A per-chunk duplicate of this cache costs at most one extra fetch — caching
// is safe module state, unlike coordination state; see
// feedback_css_contain_traps_fixed_modals.md.) Mutations invalidate it so a
// later fresh mount refetches; already-mounted instances stay in sync via the
// WATCHLIST_SYNC broadcast above.
let watchlistCache: { userId: string; promise: Promise<WatchlistEntry[]> } | null = null;

async function fetchWatchlist(userId: string): Promise<WatchlistEntry[]> {
  const client = getSupabaseClient();
  if (!client) return [];
  const { data, error: err } = await client
    .from('watchlist')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (err) throw err;
  return (data || []) as WatchlistEntry[];
}

function getWatchlistCached(userId: string): Promise<WatchlistEntry[]> {
  if (!watchlistCache || watchlistCache.userId !== userId) {
    const promise = fetchWatchlist(userId).catch(e => {
      // Never cache a failure — one transient blip must not blank every card's
      // bookmark for the session. Next mount retries.
      if (watchlistCache?.promise === promise) watchlistCache = null;
      throw e;
    });
    watchlistCache = { userId, promise };
  }
  return watchlistCache.promise;
}

function invalidateWatchlistCache(): void {
  watchlistCache = null;
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

  // Pass force=true to bypass the shared cache when fresh data is required
  // after an out-of-band write (e.g. bulk CSV import, which inserts watchlist
  // rows directly rather than through addToWatchlist). Mount effects should
  // omit it so 30 cards dedupe to one GET.
  const getWatchlist = useCallback(async (force = false): Promise<WatchlistEntry[]> => {
    const client = getSupabaseClient();
    if (!client || !userId) return [];

    setLoading(true);
    setError(null);
    try {
      if (force) invalidateWatchlistCache();
      const promise = getWatchlistCached(userId);
      const result = await promise;
      // Commit only if this fetch is still the current cache entry. A mutation
      // (or a forced refresh) that invalidated the cache mid-flight has already
      // broadcast fresher, post-write state; letting this now-superseded fetch
      // run setWatchlist/broadcast would silently clobber that truth back to the
      // pre-write snapshot it captured. Stale in-flight commits were possible in
      // the pre-cache per-instance fetches too; the shared promise lets us fix it.
      if (watchlistCache?.promise === promise) {
        setWatchlist(result);
        broadcastWatchlist(userId, result);
      }
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
    if (!userId) return;

    setError(null);
    try {
      const { error: err } = await supabaseRestInsert('watchlist', { user_id: userId, show_id: showId });
      if (err) throw new Error(err.message);

      track('watchlist_add', { show_id: showId });

      // Later fresh mounts must refetch, not read a cache missing this show.
      invalidateWatchlistCache();
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
    if (!userId) return;

    setError(null);
    try {
      const { error: err } = await supabaseRestDelete('watchlist', `user_id=eq.${userId}&show_id=eq.${showId}`);
      if (err) throw new Error(err.message);

      track('watchlist_remove', { show_id: showId });

      // Later fresh mounts must refetch, not read a cache still holding this show.
      invalidateWatchlistCache();
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
    if (!userId) return;

    setError(null);
    try {
      const { data, error: err } = await supabaseRestUpdate(
        'watchlist',
        `user_id=eq.${userId}&show_id=eq.${showId}`,
        { planned_date: plannedDate },
      );
      if (err) throw new Error(err.message);
      // PostgREST returns 200 + [] when the filter matched nothing (e.g. the
      // entry was removed in another tab) — that's a failed save, not success.
      // Same guard as the review-edit path in ShowHeroRedesign.handleSaveReview.
      if (!data) throw new Error('This show is no longer on your watchlist.');

      // Later fresh mounts must refetch, not read a cache with the stale date.
      invalidateWatchlistCache();
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
