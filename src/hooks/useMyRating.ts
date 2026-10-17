'use client';

import { useState, useEffect } from 'react';
import { supabaseRestSelect } from '@/lib/supabase-rest';

/**
 * Shared show_id → latest-rating map for the signed-in user.
 *
 * Browse pages render ~30 poster cards, each showing "my relationship with this
 * show" in the corner (ShowPageBookmark). A per-card fetch would be 30 identical
 * GETs, so all instances share ONE in-flight fetch via a module-level cache.
 * (A per-chunk duplicate of this cache costs at most one extra fetch — caching
 * is safe module state, unlike coordination state; see
 * feedback_css_contain_traps_fixed_modals.md.)
 *
 * Refresh: dispatch RATINGS_SYNC_EVENT after any rating save/delete
 * (ShowHeroRedesign does this) — every mounted hook refetches.
 */

export const RATINGS_SYNC_EVENT = 'bsc-ratings-sync';

let cache: { userId: string; promise: Promise<Map<string, number>> } | null = null;

async function fetchRatingsMap(userId: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  // Explicit user_id filter: RLS already scopes to own rows today, but a future
  // public-reviews policy must not turn other people's ratings into "Your rating"
  // chips. Cap well above any real user's show count.
  const { data, error } = await supabaseRestSelect<{ show_id: string; rating: number }>(
    'reviews',
    `user_id=eq.${userId}&select=show_id,rating,created_at&order=created_at.desc&limit=2000`,
  );
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    if (!map.has(row.show_id)) map.set(row.show_id, row.rating); // first = latest
  }
  return map;
}

function getRatingsMap(userId: string): Promise<Map<string, number>> {
  if (!cache || cache.userId !== userId) {
    const promise = fetchRatingsMap(userId).catch(e => {
      // Never cache a failure — one transient blip must not blank the chips
      // for the whole session. Next mount retries.
      if (cache?.promise === promise) cache = null;
      throw e;
    });
    cache = { userId, promise };
  }
  return cache.promise;
}

export function invalidateRatingsCache(): void {
  cache = null;
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(RATINGS_SYNC_EVENT));
  }
}

/** The signed-in user's latest rating for a show, or null. */
export function useMyRating(userId: string | null, showId: string): number | null {
  const [rating, setRating] = useState<number | null>(null);

  useEffect(() => {
    if (!userId) { setRating(null); return; }
    let alive = true;
    const load = () => {
      getRatingsMap(userId).then(map => {
        if (alive) setRating(map.get(showId) ?? null);
      }).catch(() => { /* chip is decorative — stay null on failure */ });
    };
    load();
    const onSync = () => { load(); };
    document.addEventListener(RATINGS_SYNC_EVENT, onSync);
    return () => { alive = false; document.removeEventListener(RATINGS_SYNC_EVENT, onSync); };
  }, [userId, showId]);

  return rating;
}
