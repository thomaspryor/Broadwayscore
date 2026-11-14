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

/** Advertise the live date and encore, then only the encore until it expires. */
export function liveInHdLine(h?: LiveInHd | null, today: string = new Date().toISOString().slice(0, 10)): string | null {
  if (!h || !h.date || !liveInHdIsCurrent(h, today)) return null;
  const live = formatShowDate(h.date, SHORT);
  if (!live) return null;
  const enc = h.encoreDate ? formatShowDate(h.encoreDate, SHORT) : '';
  if (h.date < today) return enc ? `In cinemas: encore ${enc}` : null;
  return enc ? `In cinemas ${live} (encore ${enc})` : `In cinemas ${live}`;
}

/** Compact sentence so the broadcast date fits alongside the review verdict. */
export function liveInHdDescription(h?: LiveInHd | null, today: string = new Date().toISOString().slice(0, 10)): string | null {
  if (!h || !h.date || !liveInHdIsCurrent(h, today)) return null;
  const isEncore = h.date < today;
  const date = formatShowDate(isEncore ? h.encoreDate : h.date, SHORT);
  return date ? `Met Live in HD ${isEncore ? 'encore' : 'cinema broadcast'}: ${date}.` : null;
}
