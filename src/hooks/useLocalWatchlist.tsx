'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useToastSafe } from '@/components/ui/Toast';
import { trackUgc } from '@/lib/ugc-analytics';
import {
  LOCAL_WATCHLIST_SYNC,
  LIST_KEY,
  addLocalShow,
  getLastPromptedAt,
  getLocalWatchlist,
  markPrompted,
  removeLocalShow,
  shouldPromptAfterSave,
  type LocalWatchlistEntry,
} from '@/lib/local-watchlist';

/**
 * Signed-out half of the watchlist toggle (BRO-4616, "save first, ask later").
 * Callers keep their signed-in path as is and call toggleLocal() where they
 * used to open the sign-in modal.
 *
 * The save always happens first. Then the sign-in sheet opens (at most once per
 * cooldown); other saves get a toast with a "Keep it everywhere" sign-in link.
 * Funnel sources: 'watchlist_toast' (toast link) and 'watchlist_saved' (sheet).
 */
export function useLocalWatchlist() {
  const { showSignIn } = useAuth();
  const { showToast } = useToastSafe();
  const [list, setList] = useState<LocalWatchlistEntry[]>([]);

  useEffect(() => {
    setList(getLocalWatchlist());
    const handler = (e: Event) => setList((e as CustomEvent<LocalWatchlistEntry[]>).detail);
    // Other tabs: without this a stale tab shows a saved show as unsaved, and
    // tapping it there would remove the save.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === LIST_KEY) setList(getLocalWatchlist());
    };
    document.addEventListener(LOCAL_WATCHLIST_SYNC, handler);
    window.addEventListener('storage', onStorage);
    return () => {
      document.removeEventListener(LOCAL_WATCHLIST_SYNC, handler);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const isSavedLocally = useCallback(
    (showId: string) => list.some(e => e.showId === showId),
    [list],
  );

  const toggleLocal = useCallback((showId: string, source: string) => {
    if (getLocalWatchlist().some(e => e.showId === showId)) {
      removeLocalShow(showId);
      trackUgc('watchlist_remove', { show_id: showId, reason: 'user', local: true, source });
      showToast?.('Removed from your saved shows', 'info');
      return;
    }
    const next = addLocalShow(showId);
    trackUgc('watchlist_add', { show_id: showId, local: true, source, local_count: next.length });
    const now = Date.now();
    if (shouldPromptAfterSave(next.length, getLastPromptedAt(), now)) {
      markPrompted(now);
      showSignIn('watchlist_local', 'watchlist_saved');
      return;
    }
    showToast?.(
      <>
        Added to your list.{' '}
        <button
          type="button"
          onClick={() => showSignIn('watchlist_local', 'watchlist_toast')}
          className="underline font-semibold hover:text-white/90"
        >
          Keep it everywhere
        </button>
      </>,
      'success',
    );
  }, [showSignIn, showToast]);

  return { localList: list, isSavedLocally, toggleLocal };
}
