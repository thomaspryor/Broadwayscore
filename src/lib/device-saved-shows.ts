/**
 * Signed-out My Shows: which device-saved shows to list (BRO-4903 item b).
 *
 * Shows saved while signed out live only in this browser (local-watchlist.ts).
 * Before this, /my-shows ignored them and showed only the sign-in pitch, so a
 * saved show was a dead end (92 phone saves on 33 devices, 1 ever migrated).
 * Signed-out /my-shows now lists them above the pitch.
 *
 * Pure so it can be unit-tested (CLAUDE.md §15). Rules:
 * - ids the show lookup doesn't know (retired, renamed, never published) are
 *   dropped silently, never rendered as raw ids;
 * - a show saved twice (hand-edited or legacy storage) appears once;
 * - shows you can still see come first, closed shows after;
 * - within each group, most recently saved first.
 */
import type { LocalWatchlistEntry } from './local-watchlist';

/** The fields this needs from a show lookup row (a ShowLookup satisfies it). */
export interface DeviceSavedShowSource {
  id: string;
  status: string;
  closingDate?: string | null;
}

export interface DeviceSavedShow<T extends DeviceSavedShowSource> {
  show: T;
  savedAt: number;
  /** Closed by status, or its closing date (YYYY-MM-DD) is before `today`. */
  closed: boolean;
}

export function isShowClosed(show: DeviceSavedShowSource, today: string): boolean {
  if (show.status === 'closed') return true;
  const closing = show.closingDate ? show.closingDate.slice(0, 10) : '';
  return !!closing && closing < today;
}

/**
 * @param entries the device list (any order; duplicates allowed)
 * @param lookup show id → show; ids missing from it are skipped
 * @param today viewer-local YYYY-MM-DD
 */
export function selectDeviceSavedShows<T extends DeviceSavedShowSource>(
  entries: readonly LocalWatchlistEntry[],
  lookup: Readonly<Record<string, T | undefined>>,
  today: string,
): DeviceSavedShow<T>[] {
  const byId = new Map<string, DeviceSavedShow<T>>();
  for (const e of entries) {
    if (!e || typeof e.showId !== 'string') continue;
    const show = Object.prototype.hasOwnProperty.call(lookup, e.showId) ? lookup[e.showId] : undefined;
    if (!show) continue;
    const savedAt = typeof e.savedAt === 'number' && Number.isFinite(e.savedAt) ? e.savedAt : 0;
    const prev = byId.get(e.showId);
    // Keep the latest save time for a duplicated id.
    if (prev && prev.savedAt >= savedAt) continue;
    byId.set(e.showId, { show, savedAt, closed: isShowClosed(show, today) });
  }
  return Array.from(byId.values()).sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? 1 : -1;
    return b.savedAt - a.savedAt;
  });
}
