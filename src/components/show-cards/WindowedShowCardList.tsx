'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ShowListCard from './ShowListCard';
import { INITIAL_SHOW_COUNT, LOAD_MORE_STEP } from '@/lib/market-list-window';
import { sameTitleShowIds } from '@/lib/same-title-shows';
import type { ShowCardShow, ScoreModeParam } from './types';

export interface WindowedShowCardListProps<T extends ShowCardShow> {
  shows: T[];
  hideStatus: boolean;
  scoreMode: ScoreModeParam;
  ariaLabel: string;
  showCategoryBadge?: boolean;
}

/**
 * Main show list for market pages (West End, Off-Broadway, Off-West End).
 * Renders INITIAL_SHOW_COUNT cards, then grows as a sentinel nears the
 * viewport. Mirrors the homepage ShowCardList so the prerendered HTML stays
 * small (BRO-5991).
 */
export default function WindowedShowCardList<T extends ShowCardShow>({
  shows,
  hideStatus,
  scoreMode,
  ariaLabel,
  showCategoryBadge,
}: WindowedShowCardListProps<T>) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_SHOW_COUNT);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sameTitleIds = useMemo(() => sameTitleShowIds(shows), [shows]);

  // Reset when the list changes (filter/sort/search)
  useEffect(() => {
    setVisibleCount(INITIAL_SHOW_COUNT);
  }, [shows]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || visibleCount >= shows.length) return;

    if (typeof IntersectionObserver === 'undefined') {
      // No observer (old/embedded browser): show everything rather than freeze at the first window.
      setVisibleCount(shows.length);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + LOAD_MORE_STEP, shows.length));
        }
      },
      { rootMargin: '400px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, shows.length]);

  const visibleShows = shows.length <= INITIAL_SHOW_COUNT ? shows : shows.slice(0, visibleCount);

  return (
    <div className="space-y-3" role="list" aria-label={ariaLabel}>
      {visibleShows.map((show, index) => (
        <ShowListCard
          key={show.id}
          show={show}
          index={index}
          hideStatus={hideStatus}
          scoreMode={scoreMode}
          showCategoryBadge={showCategoryBadge}
          showVenue={sameTitleIds.has(show.id)}
        />
      ))}
      {visibleCount < shows.length && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}
    </div>
  );
}
