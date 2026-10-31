/**
 * Shared Diary: turn a loaded share into the plain props the page renders
 * (BRO-4566). Pure apart from the injected show map, so the page, its preview
 * image and tests build the same thing.
 */
import { formatShowDate } from '@/lib/date-utils';
import { selectSharedDiary, type SharedDiaryPayload } from './select';
import type { PlanShowLike } from '@/lib/shared-plans/select';

/** The resolved-show fields the diary page needs (a PlanShow satisfies it). */
export interface DiaryShow extends PlanShowLike {
  title: string;
  href: string;
  posterUrl: string | null;
  venue: string;
}

export interface SeenEntryView {
  showId: string;
  title: string;
  href: string;
  posterUrl: string | null;
  venue: string;
  /** YYYY-MM-DD or null. */
  date: string | null;
  /** "Oct 18" for the poster pill; null when undated. */
  dateLabel: string | null;
  rating: number;
  text: string | null;
}

export interface SeenYearGroup {
  /** "2026", or null for undated entries (shown last as "No date"). */
  year: string | null;
  entries: SeenEntryView[];
}

export interface SharedDiaryView {
  name: string;
  showText: boolean;
  capped: boolean;
  showsSeen: number;
  groups: SeenYearGroup[];
  /** Up to 4 posters of the most recent entries, for the preview card. */
  recentPosters: string[];
}

/**
 * Release 1 shows dates and stars only. Notes stay out of the view even when
 * the owner's row has show_text on (another client could set it first):
 * everything in the view is serialised into the page's HTML. Release 2 (the
 * notes switch, Sprint D) turns this on.
 */
export const NOTES_ON_PAGE = false;

export function buildSharedDiaryView(
  payload: SharedDiaryPayload,
  shows: ReadonlyMap<string, DiaryShow>,
  nowMs: number,
): SharedDiaryView {
  const selected = selectSharedDiary(payload, shows, nowMs);
  const groups: SeenYearGroup[] = [];
  for (const e of selected.entries) {
    // YYYY-MM-DD strings: the year is the first four characters, no Date
    // parsing (a UTC-midnight Date shows the previous day west of UTC).
    const year = e.date ? e.date.slice(0, 4) : null;
    let g = groups[groups.length - 1];
    if (!g || g.year !== year) { g = { year, entries: [] }; groups.push(g); }
    g.entries.push({
      showId: e.show.id,
      title: e.show.title,
      href: e.show.href,
      posterUrl: e.show.posterUrl,
      venue: e.show.venue,
      date: e.date,
      dateLabel: e.date ? formatShowDate(e.date, { month: 'short', day: 'numeric' }) : null,
      rating: e.rating,
      text: NOTES_ON_PAGE ? e.text : null,
    });
  }
  const recentPosters: string[] = [];
  for (const e of selected.entries) {
    if (e.show.posterUrl && !recentPosters.includes(e.show.posterUrl)) recentPosters.push(e.show.posterUrl);
    if (recentPosters.length === 4) break;
  }
  return { name: payload.name, showText: payload.showText, capped: selected.capped, showsSeen: selected.showsSeen, groups, recentPosters };
}

/** "Tom's theater diary" / "Chris' theater diary". */
export function diaryTitle(name: string): string {
  const n = name.trim();
  return `${n}${/s$/i.test(n) ? '’' : '’s'} theater diary`;
}

/** "112 shows seen" / "1 show seen" (distinct shows, as the app counts). */
export function diarySummary(showsSeen: number): string {
  return `${showsSeen} ${showsSeen === 1 ? 'show' : 'shows'} seen`;
}
