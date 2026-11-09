'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  LOCAL_RATINGS_SYNC,
  RATINGS_KEY,
  getLocalRatings,
  type LocalRating,
} from '@/lib/local-ratings';

/** Signed-out ratings saved on this device (BRO-6917), kept in sync across hooks and tabs. */
export function useLocalRatings() {
  const [list, setList] = useState<LocalRating[]>([]);

  useEffect(() => {
    setList(getLocalRatings());
    const handler = (e: Event) => setList((e as CustomEvent<LocalRating[]>).detail);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === RATINGS_KEY) setList(getLocalRatings());
    };
    document.addEventListener(LOCAL_RATINGS_SYNC, handler);
    window.addEventListener('storage', onStorage);
    return () => {
      document.removeEventListener(LOCAL_RATINGS_SYNC, handler);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const getLocalRating = useCallback(
    (showId: string) => list.find(e => e.showId === showId) ?? null,
    [list],
  );

  return { localRatings: list, getLocalRating };
}
