'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PHOTO_SIGNED_URL_TTL_SECONDS,
  groupPhotosByReview,
  listUserReviewPhotos,
  onReviewPhotosChanged,
  signReviewPhotoPaths,
  type FeedPhoto,
} from '@/lib/review-photos';

export interface FeedPhotosState {
  photosByReview: Record<string, FeedPhoto[]>;
  loading: boolean;
  error: string | null;
  /** The current user's saved photos have loaded (upload slots can be counted). */
  ready: boolean;
  retry: () => void;
}

/** A signed URL is reused until 80% of its lifetime has passed. */
const REUSE_MS = PHOTO_SIGNED_URL_TTL_SECONDS * 800;

/**
 * The signed-in user's diary photos, keyed by review id; pass `reviewId` to
 * load one entry's photos only (the rating editor). Mock mode returns the
 * stand-in set from __dev-mock-photos (loaded lazily so it never ships in
 * the production bundle) and makes no network call.
 *
 * Refreshes whenever an upload or delete anywhere on the page announces a
 * change (emitReviewPhotosChanged). Signed URLs that are still fresh are
 * reused across refreshes so photos already on screen don't re-download;
 * when the tab comes back after most of the TTL has passed, everything is
 * signed again.
 */
export function useFeedPhotos(userId: string | null, isMockMode: boolean, opts: { reviewId?: string } = {}): FeedPhotosState {
  const { reviewId } = opts;
  const [photosByReview, setPhotosByReview] = useState<Record<string, FeedPhoto[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True only once the current user's photos have loaded. Upload slots are
  // counted from photosByReview, so until then "Add" must stay closed or a
  // load failure would read as six free slots (ship-check, BRO-6170).
  const [ready, setReady] = useState(false);
  const signedAt = useRef(0);
  const requestId = useRef(0);
  const signedCache = useRef(new Map<string, { url: string; at: number }>());

  const load = useCallback(async () => {
    const id = ++requestId.current;
    if (isMockMode) {
      setLoading(true);
      const mod = await import('./__dev-mock-photos');
      if (id !== requestId.current) return;
      // ?mockphotos=0 renders the no-photos state (design review of the empty wall).
      const none = new URLSearchParams(window.location.search).get('mockphotos') === '0';
      const all = mod.buildMockPhotosByReview({ seeded: !none });
      setPhotosByReview(reviewId ? (all[reviewId] ? { [reviewId]: all[reviewId] } : {}) : all);
      setError(null);
      setReady(true);
      setLoading(false);
      return;
    }
    if (!userId) {
      setPhotosByReview({});
      setReady(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await listUserReviewPhotos(userId, reviewId);
      const now = Date.now();
      const cache = signedCache.current;
      const stale = rows.map(r => r.storage_path).filter(p => {
        const hit = cache.get(p);
        return !hit || now - hit.at > REUSE_MS;
      });
      const fresh = await signReviewPhotoPaths(stale);
      if (id !== requestId.current) return;
      for (const [path, url] of Object.entries(fresh)) cache.set(path, { url, at: now });
      const signed: Record<string, string> = {};
      for (const r of rows) {
        const hit = cache.get(r.storage_path);
        if (hit) signed[r.storage_path] = hit.url;
      }
      setPhotosByReview(groupPhotosByReview(rows, signed));
      setReady(true);
      signedAt.current = Math.min(...rows.map(r => cache.get(r.storage_path)?.at ?? now), now);
      setError(null);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Could not load photos');
      setReady(false);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [userId, isMockMode, reviewId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => onReviewPhotosChanged(changed => {
    if (!reviewId || !changed || changed === reviewId) load();
  }), [load, reviewId]);

  useEffect(() => {
    if (isMockMode || !userId) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const ageMs = Date.now() - signedAt.current;
      if (signedAt.current && ageMs > REUSE_MS) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    // A tab left open and visible never fires visibilitychange, so lazy tiles
    // scrolled into view after the TTL would load expired URLs. Check once a
    // minute too.
    const timer = setInterval(onVisible, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [isMockMode, userId, load]);

  return { photosByReview, loading, error, ready, retry: load };
}
