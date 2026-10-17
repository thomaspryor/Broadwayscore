'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { trackUgc } from '@/lib/ugc-analytics';
import { getSupabaseClient } from '@/lib/supabase';
import { supabaseRestInsert, supabaseRestDelete, supabaseRestUpdate } from '@/lib/supabase-rest';
import { getLocalWatchlist, removeLocalShow, showsToMigrate } from '@/lib/local-watchlist';
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

// Signed-out saves (src/lib/local-watchlist.ts) move into the account on the
// first mount after sign-in. Module-level so the ~30 bookmark instances on a
// browse page share one in-flight run. Shows the account already has, or has rated
// (rated = seen, so they don't belong on the watchlist), are skipped. A failed
// insert stays saved locally and is retried on the next page load.
let localMigration: { userId: string; promise: Promise<WatchlistEntry[] | null> } | null = null;

async function migrateLocalWatchlist(userId: string): Promise<WatchlistEntry[] | null> {
  const local = getLocalWatchlist();
  if (local.length === 0) return null;
  const client = getSupabaseClient();
  if (!client) return null;
  const [account, rated] = await Promise.all([
    fetchWatchlist(userId),
    client.from('reviews').select('show_id').eq('user_id', userId).then(({ data, error }) => {
      if (error) throw error;
      return (data || []) as { show_id: string }[];
    }),
  ]);
  const ratedIds = new Set(rated.map(r => r.show_id));
  const toAdd = showsToMigrate(local, account.map(w => w.show_id)).filter(id => !ratedIds.has(id));
  let added = 0;
  for (const showId of toAdd) {
    // Removed meanwhile (e.g. rated while this ran): rated shows stay off the list.
    if (!getLocalWatchlist().some(e => e.showId === showId)) continue;
    const { error } = await supabaseRestInsert('watchlist', { user_id: userId, show_id: showId });
    // 23505 = UNIQUE(user_id, show_id): another tab migrated it first.
    if (!error || error.code === '23505') {
      if (!error) added++;
      removeLocalShow(showId);
    }
  }
  // Skipped shows (already on the account, or rated) are done too.
  for (const e of local) {
    if (!toAdd.includes(e.showId)) removeLocalShow(e.showId);
  }
  trackUgc('watchlist_local_migrated', { local_count: local.length, added, failed: toAdd.length - added });
  invalidateWatchlistCache();
  return getWatchlistCached(userId);
}

// A show that keeps failing (not a duplicate) must not re-run the migration on
// every later mount; a few tries per page load, then the next load retries.
const MAX_MIGRATION_RUNS = 3;
let migrationRuns = 0;

function migrateLocalWatchlistOnce(userId: string): Promise<WatchlistEntry[] | null> {
  if (!localMigration || localMigration.userId !== userId) {
    if (migrationRuns >= MAX_MIGRATION_RUNS) return Promise.resolve(null);
    migrationRuns++;
    // Cleared once settled, so a later mount retries anything still saved
    // locally (failed inserts, or saves made after signing out and back in).
    const promise: Promise<WatchlistEntry[] | null> = migrateLocalWatchlist(userId)
      .catch(() => null)
      .finally(() => {
        if (localMigration?.promise === promise) localMigration = null;
      });
    localMigration = { userId, promise };
  }
  return localMigration.promise;
}

export function useWatchlist(userId: string | null) {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const watchlistRef = useRef(watchlist);
  watchlistRef.current = watchlist;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The account whose list `watchlist` holds (fetched, synced from another
  // instance, or merged after the local move); null while it is the initial [].
  const loadedFor = useRef<string | null>(null);

  // Listen for sync events from other instances
  useEffect(() => {
    if (!userId) return;
    const handler = (e: Event) => {
      const { userId: eventUserId, entries } = (e as CustomEvent).detail;
      if (eventUserId === userId) {
        loadedFor.current = userId;
        setWatchlist(entries);
      }
    };
    document.addEventListener(WATCHLIST_SYNC, handler);
    return () => document.removeEventListener(WATCHLIST_SYNC, handler);
  }, [userId]);

  useEffect(() => {
    if (!userId || getLocalWatchlist().length === 0) return;
    let cancelled = false;
    migrateLocalWatchlistOnce(userId).then(merged => {
      if (cancelled || !merged) return;
      loadedFor.current = userId;
      setWatchlist(merged);
      broadcastWatchlist(userId, merged);
    });
    return () => { cancelled = true; };
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
        loadedFor.current = userId;
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

  /**
   * Optimistic update after a write + broadcast to other instances. An
   * instance that never loaded the list (the welcome sheet only removes) must
   * not broadcast an edit of its placeholder [], which would blank every other
   * watchlist view on the page; it shares a fresh fetch instead. Callers
   * invalidate the cache first, so that fetch sees their write.
   */
  const commitEdit = useCallback((edit: (prev: WatchlistEntry[]) => WatchlistEntry[]) => {
    if (!userId) return;
    if (loadedFor.current !== userId) {
      const promise = getWatchlistCached(userId);
      promise.then(fresh => {
        // Superseded by a later write's fetch: that one broadcasts.
        if (watchlistCache?.promise !== promise) return;
        loadedFor.current = userId;
        setWatchlist(fresh);
        broadcastWatchlist(userId, fresh);
      }).catch(() => { /* other views keep their list; the next mount refetches */ });
      return;
    }
    setWatchlist(prev => {
      const next = edit(prev);
      broadcastWatchlist(userId, next);
      return next;
    });
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

      trackUgc('watchlist_add', { show_id: showId });

      // Later fresh mounts must refetch, not read a cache missing this show.
      invalidateWatchlistCache();
      commitEdit(prev => [
        {
          id: crypto.randomUUID(), user_id: userId, show_id: showId,
          // A freshly added show has no date and therefore no time yet.
          planned_date: null, time_slot: null, curtain_time: null,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to add to watchlist';
      setError(msg);
      throw new Error(msg);
    }
  }, [userId, commitEdit]);

  // reason 'rated': saving a rating clears the watchlist entry unconditionally,
  // usually a no-op delete, so only a real removal is counted.
  const removeFromWatchlist = useCallback(async (showId: string, reason: 'user' | 'rated' = 'user'): Promise<void> => {
    if (!userId) return;

    setError(null);
    try {
      const { error: err } = await supabaseRestDelete('watchlist', `user_id=eq.${userId}&show_id=eq.${showId}`);
      if (err) throw new Error(err.message);

      if (reason === 'user' || watchlistRef.current.some(w => w.show_id === showId)) {
        trackUgc('watchlist_remove', { show_id: showId, reason });
      }

      // Later fresh mounts must refetch, not read a cache still holding this show.
      invalidateWatchlistCache();
      commitEdit(prev => prev.filter(w => w.show_id !== showId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to remove from watchlist';
      setError(msg);
      throw new Error(msg);
    }
  }, [userId, commitEdit]);

  /**
   * The single write path for everything describing WHEN a planned show is:
   * date, time slot, and curtain time together in one PATCH.
   *
   * One call rather than a date write plus a separate time write, because each
   * write here also invalidates the module cache and broadcasts the new list to
   * every other mounted instance. Two sequential writes would broadcast twice,
   * and a failure between them would leave the My Shows card and the show page
   * disagreeing about the same entry until a refetch. The database enforces the
   * matching rule (curtain_time requires a time_slot), so the fields have to
   * travel together anyway.
   */
  const updatePerformance = useCallback(async (
    showId: string,
    fields: Partial<Pick<WatchlistEntry, 'planned_date' | 'time_slot' | 'curtain_time'>>,
  ): Promise<void> => {
    if (!userId) return;
    if (Object.keys(fields).length === 0) return;

    setError(null);
    try {
      const { data, error: err } = await supabaseRestUpdate(
        'watchlist',
        `user_id=eq.${userId}&show_id=eq.${showId}`,
        fields,
      );
      if (err) throw new Error(err.message);
      // PostgREST returns 200 + [] when the filter matched nothing (e.g. the
      // entry was removed in another tab) — that's a failed save, not success.
      // Same guard as the review-edit path in ShowHeroRedesign.handleSaveReview.
      if (!data) throw new Error('This show is no longer on your watchlist.');

      // Later fresh mounts must refetch, not read a cache with stale values.
      invalidateWatchlistCache();
      commitEdit(prev => prev.map(w =>
        w.show_id === showId ? { ...w, ...fields } : w
      ));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to update this show';
      setError(msg);
      throw new Error(msg);
    }
  }, [userId, commitEdit]);

  /**
   * Date-only convenience wrapper. Delegates rather than issuing its own PATCH
   * so there is exactly one place that knows how to write a watchlist row —
   * two copies would drift on the cache/broadcast handling, which is precisely
   * the bug that made this refactor necessary.
   *
   * ALWAYS clears time_slot/curtain_time, including when setting a new
   * non-null date over an existing one. A curtain time with no date makes no
   * sense (the original reason for this); a curtain time resolved for a
   * DIFFERENT date makes just as little sense — matinee/evening times are
   * resolved per-date (see resolveShowtimeDefault), so re-dating a show would
   * otherwise silently carry the old date's showtime forward, including into
   * the Add to Calendar event (BRO-221 review finding, 2026-08-17).
   */
  const updatePlannedDate = useCallback(async (showId: string, plannedDate: string | null): Promise<void> => {
    return updatePerformance(showId, { planned_date: plannedDate, time_slot: null, curtain_time: null });
  }, [updatePerformance]);

  return {
    watchlist,
    loading,
    error,
    getWatchlist,
    isWatchlisted,
    addToWatchlist,
    removeFromWatchlist,
    updatePlannedDate,
    updatePerformance,
  };
}
