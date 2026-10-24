'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PHOTO_SIGNED_URL_TTL_SECONDS,
  groupPhotosByReview,
  listUserReviewPhotos,
  signReviewPhotoPaths,
  type FeedPhoto,
} from '@/lib/review-photos';

export interface FeedPhotosState {
  photosByReview: Record<string, FeedPhoto[]>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * The signed-in user's diary photos, keyed by review id. Mock mode returns
 * the stand-in set from __dev-mock-photos (loaded lazily so it never ships
 * in the production bundle) and makes no network call.
 *
 * Signed URLs are short-lived: when the tab comes back after most of the TTL
 * has passed, the list is fetched and signed again.
 */
export function useFeedPhotos(userId: string | null, isMockMode: boolean): FeedPhotosState {
  const [photosByReview, setPhotosByReview] = useState<Record<string, FeedPhoto[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedAt = useRef(0);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    if (isMockMode) {
      setLoading(true);
      const mod = await import('./__dev-mock-photos');
      if (id !== requestId.current) return;
      // ?mockphotos=0 renders the no-photos state (design review of the empty wall).
      const none = new URLSearchParams(window.location.search).get('mockphotos') === '0';
      setPhotosByReview(none ? {} : mod.buildMockPhotosByReview());
      setError(null);
      setLoading(false);
      return;
    }
    if (!userId) {
      setPhotosByReview({});
      return;
    }
    setLoading(true);
    try {
      const rows = await listUserReviewPhotos(userId);
      const signed = await signReviewPhotoPaths(rows.map(r => r.storage_path));
      if (id !== requestId.current) return;
      setPhotosByReview(groupPhotosByReview(rows, signed));
      signedAt.current = Date.now();
      setError(null);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Could not load photos');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [userId, isMockMode]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (isMockMode || !userId) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const ageMs = Date.now() - signedAt.current;
      if (signedAt.current && ageMs > PHOTO_SIGNED_URL_TTL_SECONDS * 800) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [isMockMode, userId, load]);

  return { photosByReview, loading, error, retry: load };
}
