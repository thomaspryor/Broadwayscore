'use client';

// Past-week showtimes (BRO-6877). The live schedule (show-schedules.json,
// bundled) only covers this week onward; older weeks live in
// /data/show-schedule-history.json, fetched on demand by the diary form so
// pages that never open it don't pay for it.

import { useEffect, useState } from 'react';
import type { ShowSchedule } from './data-types';
import { isBeforeScheduleWindow } from './data-showtimes';

interface HistoryFile {
  firstWeek: string | null;
  throughMonday: string | null;
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
 * The archived weeks for this show, loaded only when the picked date is
 * before the live schedule window. Undefined while loading, when not needed,
 * or when the archive has nothing for the show.
 */
export function useScheduleHistory(showId: string, date: string): ShowSchedule | undefined {
  const needed = isBeforeScheduleWindow(date);
  const [history, setHistory] = useState<{ showId: string; schedule?: ShowSchedule } | null>(null);
  useEffect(() => {
    if (!needed) return;
    let live = true;
    loadScheduleHistory().then((h) => {
      if (live) setHistory({ showId, schedule: h?.shows[showId] });
    });
    return () => { live = false; };
  }, [needed, showId]);
  return needed && history?.showId === showId ? history.schedule : undefined;
}
