'use client';

// Past-week showtimes (BRO-6877). The live schedule (show-schedules.json,
// bundled) only covers this week onward; older weeks live in
// /data/show-schedule-history.json, fetched on demand by the diary form so
// pages that never open it don't pay for it.

import { useEffect, useState } from 'react';
import type { ShowSchedule } from './data-types';
import { needsScheduleHistory } from './data-showtimes';

interface HistoryFile {
  firstWeek: string | null;
  lastWeek: string | null;
  shows: Record<string, ShowSchedule>;
}

export const SCHEDULE_HISTORY_URL = '/data/show-schedule-history.json';

let pending: Promise<HistoryFile | null> | null = null;

/** One fetch per page load; a failed fetch resolves null and is retried next time. */
export function loadScheduleHistory(): Promise<HistoryFile | null> {
  if (!pending) {
    pending = fetch(SCHEDULE_HISTORY_URL)
      .then((r) => (r.ok ? (r.json() as Promise<HistoryFile>) : null))
      .catch(() => null)
      .then((h) => {
        if (!h) pending = null;
        return h;
      });
  }
  return pending;
}

/**
 * The archived weeks for this show, loaded only when the live schedule
 * can't cover the picked date (see needsScheduleHistory). `schedule` is
 * undefined while loading, when not needed, or when the archive has nothing
 * for the show; `loading` is true only while a needed fetch is in flight.
 */
export function useScheduleHistory(showId: string, date: string): { schedule?: ShowSchedule; loading: boolean } {
  const needed = needsScheduleHistory(showId, date);
  const [history, setHistory] = useState<{ showId: string; schedule?: ShowSchedule } | null>(null);
  useEffect(() => {
    if (!needed) return;
    let live = true;
    loadScheduleHistory().then((h) => {
      if (live) setHistory({ showId, schedule: h?.shows?.[showId] });
    });
    return () => { live = false; };
  }, [needed, showId]);
  const ready = history?.showId === showId;
  return { schedule: needed && ready ? history.schedule : undefined, loading: needed && !ready };
}
