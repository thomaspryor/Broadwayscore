'use client';

import { useEffect, useState } from 'react';
import { couldHaveSeenShow, dependsOnDate, type RateabilitySource } from '@/lib/show-rateability';

/**
 * couldHaveSeenShow() for rendering (BRO-77). Statuses whose answer is fixed
 * decide during render, so server and client agree. upcoming/announced need
 * the viewer's clock, which is read only after mount (a cached page rendered
 * the day before a first preview would otherwise hydrate with a different
 * answer); until then they count as not seeable.
 *
 * The post-mount answer is keyed by the inputs it was computed for, so a card
 * reused for another show never shows the previous show's answer, in either
 * direction, for the render before the effect runs.
 */
export function useCouldHaveSeenShow(show: RateabilitySource | null | undefined): boolean {
  const status = show?.status ?? null;
  const previewsStartDate = show?.previewsStartDate ?? null;
  const openingDate = show?.openingDate ?? null;
  const dateDependent = dependsOnDate(status);
  const key = `${status}|${previewsStartDate}|${openingDate}`;
  const [afterMount, setAfterMount] = useState<{ key: string; seeable: boolean } | null>(null);
  useEffect(() => {
    if (dateDependent) setAfterMount({ key, seeable: couldHaveSeenShow({ status, previewsStartDate, openingDate }) });
  }, [dateDependent, key, status, previewsStartDate, openingDate]);
  if (!dateDependent) return true;
  return afterMount !== null && afterMount.key === key && afterMount.seeable;
}
