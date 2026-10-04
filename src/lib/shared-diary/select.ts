/**
 * Shared Diary: which of a person's diary entries a friend sees (BRO-4566,
 * docs/specs/shared-diary.md §2.3).
 *
 * ONE rule for the public page, its preview image and the owner's share sheet
 * counts, so the three can never disagree. Pure: no I/O, no clock reads.
 *
 * "Seen" = undated, or dated before the show's venue-local today (the plans
 * rule, venueToday). Tonight's show and anything later are plans and never
 * appear here, even though get_shared_diary() returns rows up to UTC today.
 */
import { venueToday, type PlanShowLike } from '@/lib/shared-plans/select';

/** What get_shared_diary() returns (supabase/migrations/20261004_diary_shares.sql). */
export interface SharedDiaryPayload {
  name: string;
  showText: boolean;
  capped: boolean;
  entries: SharedDiaryEntry[];
}

export interface SharedDiaryEntry {
  show_id: string;
  /** YYYY-MM-DD, or null when the owner never set a date. */
  date_seen: string | null;
  rating: number;
  /** Present only when the owner shares notes. */
  text?: string;
}

export interface SeenEntry<T> {
  show: T;
  date: string | null;
  rating: number;
  /** Only when the owner shares notes and this entry has one. */
  text: string | null;
}

export interface SelectedSharedDiary<T> {
  /** Newest first, undated last (the function's order, kept). */
  entries: Array<SeenEntry<T>>;
  /** Distinct shows among `entries` (the app's "N shows seen" rule). */
  showsSeen: number;
  /** Entries with a note, whether or not notes are shared (owner sheet). */
  withNotes: number;
  capped: boolean;
}

export function selectSharedDiary<T extends PlanShowLike>(
  payload: Pick<SharedDiaryPayload, 'showText' | 'capped' | 'entries'>,
  shows: ReadonlyMap<string, T>,
  nowMs: number,
): SelectedSharedDiary<T> {
  const entries: Array<SeenEntry<T>> = [];
  let withNotes = 0;
  for (const e of payload.entries) {
    const show = shows.get(e.show_id);
    // Ids the build can't resolve are dropped rather than shown as raw ids.
    if (!show) continue;
    if (e.date_seen !== null && e.date_seen >= venueToday(show.category, nowMs)) continue;
    const note = typeof e.text === 'string' && e.text.trim() !== '' ? e.text : null;
    if (note) withNotes++;
    entries.push({ show, date: e.date_seen, rating: e.rating, text: payload.showText ? note : null });
  }
  // The function already orders rows this way; sorting again (stable, so its
  // created_at/id tiebreak survives) keeps year bands whole if that drifts.
  entries.sort((a, b) => {
    if (a.date === b.date) return 0;
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? 1 : -1;
  });
  return {
    entries,
    showsSeen: new Set(entries.map(e => e.show.id)).size,
    withNotes,
    capped: payload.capped,
  };
}

/**
 * Build a payload-shaped list from the owner's own reviews, for the share
 * sheet's counts and its notes preview. Same order as get_shared_diary().
 * `text` is always included here: the owner is looking at their own notes.
 */
export function toSharedDiaryEntries(
  reviews: ReadonlyArray<{ show_id: string; date_seen: string | null; rating: number; review_text?: string | null; created_at?: string; id?: string }>,
): SharedDiaryEntry[] {
  return [...reviews]
    .sort((a, b) => {
      if (a.date_seen !== b.date_seen) {
        if (a.date_seen === null) return 1;
        if (b.date_seen === null) return -1;
        return a.date_seen < b.date_seen ? 1 : -1;
      }
      const ca = a.created_at ?? '', cb = b.created_at ?? '';
      if (ca !== cb) return ca < cb ? 1 : -1;
      return (a.id ?? '') < (b.id ?? '') ? 1 : -1;
    })
    .map(r => {
      const e: SharedDiaryEntry = { show_id: r.show_id, date_seen: r.date_seen, rating: r.rating };
      if (r.review_text && r.review_text.trim() !== '') e.text = r.review_text.trim().slice(0, 4000);
      return e;
    });
}

/** Rows get_shared_diary() returns at most (c_cap in 20261004_diary_shares.sql). */
export const DIARY_SHARE_CAP = 1000;

/**
 * The payload the owner's link would return right now, built from the
 * owner's own reviews: same rows (undated, or dated up to UTC today), same
 * order, same cap. Feed it to selectSharedDiary for the share sheet's count,
 * so it matches the friend page past 1,000 entries too.
 */
export function ownerDiaryPayload(
  reviews: Parameters<typeof toSharedDiaryEntries>[0],
  nowMs: number,
): Pick<SharedDiaryPayload, 'capped' | 'entries'> {
  const utcToday = new Date(nowMs).toISOString().slice(0, 10);
  const rows = toSharedDiaryEntries(reviews.map(r => ({ ...r, date_seen: r.date_seen ? r.date_seen.slice(0, 10) : null })))
    .filter(e => e.date_seen === null || e.date_seen <= utcToday);
  return { capped: rows.length > DIARY_SHARE_CAP, entries: rows.slice(0, DIARY_SHARE_CAP) };
}
