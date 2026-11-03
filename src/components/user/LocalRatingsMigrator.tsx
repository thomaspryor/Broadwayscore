'use client';

import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useToastSafe } from '@/components/ui/Toast';
import { trackUgc } from '@/lib/ugc-analytics';
import { supabaseRestInsert, supabaseRestSelect } from '@/lib/supabase-rest';
import { getLocalRatings, ratingsToMigrate, removeLocalRating } from '@/lib/local-ratings';
import { removeLocalShow } from '@/lib/local-watchlist';
import { invalidateRatingsCache, RATINGS_SYNC_EVENT } from '@/hooks/useMyRating';

/** Fired after local ratings land in the account, so a mounted show page refetches its reviews. */
export const LOCAL_RATINGS_MIGRATED_EVENT = 'bsc-local-ratings-migrated';

// One run per account at a time; a failed insert stays local and retries on
// the next page load (a few tries per load, like the watchlist migration).
const MAX_RUNS = 3;
let runs = 0;
let runsFor: string | null = null;
let inFlight: string | null = null;

/**
 * Moves ratings saved while signed out into the account (BRO-6917). Mounted
 * once under AuthProvider. A show the account has already rated is skipped
 * (the account's own rating wins) and its local copy dropped.
 */
export default function LocalRatingsMigrator() {
  const { user } = useAuth();
  const { showToast } = useToastSafe();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    if (runsFor !== userId) { runsFor = userId; runs = 0; }
    if (inFlight === userId || runs >= MAX_RUNS) return;
    if (getLocalRatings().length === 0) return;
    inFlight = userId;
    runs++;
    // Two tabs sign in together: a Web Lock makes the second one wait, then
    // re-read storage (the first removed what it saved) so nothing inserts twice.
    const withLock = <T,>(fn: () => Promise<T>): Promise<T> =>
      typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request('bsc-local-ratings-migrate', fn) as Promise<T>
        : fn();
    withLock(async () => {
      try {
        const local = getLocalRatings();
        if (local.length === 0) return;
        const { data, error } = await supabaseRestSelect<{ show_id: string; rating: number }>(
          'reviews', `user_id=eq.${userId}&select=show_id,rating&limit=2000`,
        );
        if (error) return;
        const rated = (data ?? []).map(r => ({ showId: r.show_id, rating: Number(r.rating) }));
        const toAdd = ratingsToMigrate(local, rated);
        let added = 0;
        for (const r of toAdd) {
          const { error: insErr } = await supabaseRestInsert('reviews', {
            user_id: userId,
            show_id: r.showId,
            rating: r.rating,
            review_text: r.reviewText || null,
            date_seen: r.dateSeen || null,
            // Only set when present: the columns are newer than the table (BRO-6783),
            // and a curtain time needs a time slot (database rule).
            ...(r.dateSeen && r.timeSlot ? { time_slot: r.timeSlot } : {}),
            ...(r.dateSeen && r.timeSlot && r.curtainTime ? { curtain_time: r.curtainTime } : {}),
            ...(r.seat ? { seat: r.seat } : {}),
          });
          if (!insErr) {
            added++;
            removeLocalRating(r.showId);
            removeLocalShow(r.showId); // rated = seen, off the want-to-see list
          }
        }
        // Skipped (the account already holds this exact rating) are done too.
        const have = new Set(rated.map(a => `${a.showId}|${a.rating}`));
        for (const r of local) if (have.has(`${r.showId}|${r.rating}`)) removeLocalRating(r.showId);
        trackUgc('rating_local_migrated', { local_count: local.length, added, failed: toAdd.length - added });
        if (added > 0) {
          invalidateRatingsCache();
          document.dispatchEvent(new Event(RATINGS_SYNC_EVENT));
          document.dispatchEvent(new Event(LOCAL_RATINGS_MIGRATED_EVENT));
          showToast?.(added === 1 ? 'Your rating is saved to your account.' : `Your ${added} ratings are saved to your account.`, 'success');
        }
        if (toAdd.length - added > 0) {
          showToast?.("We couldn't save a rating to your account yet. It stays on this device and we'll try again.", 'error');
        }
      } finally {
        inFlight = null;
      }
    }).catch(() => { inFlight = null; });
  }, [userId, showToast]);

  return null;
}
