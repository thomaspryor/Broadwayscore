/**
 * Which performance + seat on a diary entry (BRO-6783).
 *
 * Pure helpers shared by RatingEditor, its three save paths and the diary
 * rows. The schedule lookups take the schedule as an argument so this module
 * stays free of the 170 KB schedules import (data-showtimes.ts owns that).
 */
import { formatTime } from './calendar/format';

export type TimeSlot = 'matinee' | 'evening' | 'custom';

export interface ShowtimeSeat {
  time_slot: TimeSlot | null;
  /** "HH:MM:SS" as PostgREST returns a TIME column, or null. */
  curtain_time: string | null;
  seat: string | null;
}

export const SEAT_MAX_CHARS = 40;

/** Trim, collapse inner whitespace, cap at SEAT_MAX_CHARS; '' → null. */
export function normalizeSeat(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, SEAT_MAX_CHARS).trim();
  return s ? s : null;
}

/**
 * The columns a save should send. A key is included only when it has a value
 * now or had one before (so clearing it writes null). A rating with no time
 * and no seat therefore sends none of these keys, which keeps saves working on
 * a database that does not have the columns yet (deploy-before-migration).
 */
export function buildShowtimeSeatPatch(
  initial: Partial<ShowtimeSeat> | null | undefined,
  current: ShowtimeSeat,
): Partial<ShowtimeSeat> {
  const patch: Partial<ShowtimeSeat> = {};
  const keys: (keyof ShowtimeSeat)[] = ['time_slot', 'curtain_time', 'seat'];
  for (const k of keys) {
    const now = current[k] ?? null;
    const before = initial?.[k] ?? null;
    if (now !== null || before !== null) (patch as Record<string, unknown>)[k] = now;
  }
  // DB constraint: a curtain_time needs a slot. Never send one without it.
  if (patch.curtain_time && !current.time_slot) patch.curtain_time = null;
  return patch;
}

/** "Evening · 7:00 PM", "Matinee", "7:30 PM" (custom), or null. */
export function showtimeText(e: Pick<ShowtimeSeat, 'time_slot' | 'curtain_time'>): string | null {
  const time = e.curtain_time ? formatTime(e.curtain_time.slice(0, 5)) : null;
  if (e.time_slot === 'matinee') return time ? `Matinee · ${time}` : 'Matinee';
  if (e.time_slot === 'evening') return time ? `Evening · ${time}` : 'Evening';
  if (e.time_slot === 'custom') return time;
  return null;
}

/** Diary-entry detail line: "Evening · 7:00 PM · Seat A-25", or null. Owner-only surfaces. */
export function diaryDetailText(e: Partial<ShowtimeSeat> | null | undefined): string | null {
  if (!e) return null;
  const parts = [
    showtimeText({ time_slot: e.time_slot ?? null, curtain_time: e.curtain_time ?? null }),
    e.seat ? `Seat ${e.seat}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
