// Met Live in HD cinema broadcast wording (BRO-6769). Dates live on the show row
// (shows.json `liveInHd`), verified against metopera.org, never guessed.
import { formatShowDate } from '@/lib/date-utils';

export interface LiveInHd {
  date: string;
  encoreDate?: string | null;
  sourceUrl: string;
}

const SHORT = { month: 'short', day: 'numeric', year: 'numeric' } as const;

/** True while the live date or the encore is today or later (UTC); past broadcasts stop being advertised. */
export function liveInHdIsCurrent(h?: LiveInHd | null, today: string = new Date().toISOString().slice(0, 10)): boolean {
  if (!h || !h.date) return false;
  const last = h.encoreDate && h.encoreDate > h.date ? h.encoreDate : h.date;
  return last >= today;
}

/** "In cinemas Oct 3, 2026" (+ " · encore Oct 14, 2026"), or null without a date. */
export function liveInHdLine(h?: LiveInHd | null, today?: string): string | null {
  if (!h || !h.date || !liveInHdIsCurrent(h, today)) return null;
  const live = formatShowDate(h.date, SHORT);
  if (!live) return null;
  const enc = h.encoreDate ? formatShowDate(h.encoreDate, SHORT) : '';
  return enc ? `In cinemas ${live} (encore ${enc})` : `In cinemas ${live}`;
}

/** Sentence for meta descriptions, matching "Met Live in HD <title>" searches. */
export function liveInHdDescription(title: string, h?: LiveInHd | null, today?: string): string | null {
  if (!h || !h.date || !liveInHdIsCurrent(h, today)) return null;
  const live = formatShowDate(h.date, SHORT);
  return live ? `${title} Met Live in HD cinema broadcast: ${live}.` : null;
}
