// Showtimes / weekly schedule data module
// Imports: show-schedules.json (~small) for weekly performance schedules

import type { ShowSchedule } from './data-types';
import scheduleData from '../../data/show-schedules.json';
import showtimeIdsData from '../../data/todaytix-showtimes.json';

interface ScheduleFile {
  lastUpdated: string;
  source: string;
  currentMonday: string;
  shows: Record<string, ShowSchedule>;
}

const schedules = scheduleData as unknown as ScheduleFile;

/**
 * Get schedule data for a specific show by ID
 */
export function getShowSchedule(showId: string): ShowSchedule | undefined {
  return schedules.shows[showId];
}

/**
 * Get the current Monday date string (YYYYMMDD)
 */
export function getScheduleCurrentMonday(): string {
  return schedules.currentMonday;
}

/**
 * Get last updated timestamp
 */
export function getScheduleLastUpdated(): string {
  return schedules.lastUpdated;
}

// ─── TodayTix showtime IDs (for deep links) ─────────────

export interface TodayTixShowtimeData {
  todaytixId: number;
  showtimes: Record<string, { m?: number; e?: number }>;
}

interface ShowtimeIdsFile {
  lastUpdated: string;
  shows: Record<string, TodayTixShowtimeData>;
}

const showtimeIds = showtimeIdsData as unknown as ShowtimeIdsFile;

/**
 * Get TodayTix showtime IDs for a specific show.
 * Called in the server component (page.tsx) and passed as a prop to ShowtimesCard.
 */
export function getShowShowtimeIds(showId: string): TodayTixShowtimeData | undefined {
  return showtimeIds.shows[showId];
}

// ─── Showtime picker defaults ─────────────────────────────

/** "2026-09-14" → Monday-of-week as "20260914" (bwayrush schedule key format). */
export function mondayOfWeekYyyymmdd(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay(); // 0=Sun..6=Sat
  dt.setDate(dt.getDate() + (day === 0 ? -6 : 1 - day));
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
}

/** "2026-09-14" → weekday index matching WeekSchedule's Mon=0..Sun=6 order. */
export function weekdayIndexMonFirst(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay(); // 0=Sun..6=Sat
  return day === 0 ? 6 : day - 1;
}

/** Generic curtain times used when the real schedule doesn't cover this date. */
const GENERIC_SLOT_TIME: Record<'matinee' | 'evening', string> = {
  matinee: '14:00',
  evening: '19:00',
};

/**
 * Resolve a "HH:MM" default for a matinee/evening pick on a specific planned
 * date. Prefers the actual scheduled time for that weekday (bwayrush only
 * publishes a few weeks out, so most far-future dates miss and fall back to a
 * generic convention) — either way the picker still saves a real curtain_time,
 * and the user can always override via the custom-time tier.
 *
 * Callers that can act on it should check isKnownDarkForSlot() first — this
 * function alone can't distinguish "no schedule data" from "the show is
 * confirmed dark that day" (e.g. the near-universal Broadway Monday dark
 * night), so used blindly it would fabricate a plausible-looking time for a
 * performance that isn't happening.
 */
export function resolveShowtimeDefault(showId: string, date: string, slot: 'matinee' | 'evening', history?: ShowSchedule): string {
  const scheduled = scheduledTime(showId, date, slot, history);
  return scheduled || GENERIC_SLOT_TIME[slot];
}

/**
 * True only when we have real schedule coverage for this exact date AND that
 * slot is explicitly dark — never true for an uncovered date (bwayrush's
 * rolling few-week window means "no data" is the common case, not "dark").
 */
export function isKnownDarkForSlot(showId: string, date: string, slot: 'matinee' | 'evening', history?: ShowSchedule): boolean {
  const day = dayFor(showId, date, history);
  if (!day) return false;
  return (slot === 'matinee' ? day.m : day.e) === null;
}

/** The real scheduled "HH:MM" for this slot on this date, or null (uncovered date, or dark). */
export function scheduledShowtime(showId: string, date: string, slot: 'matinee' | 'evening', history?: ShowSchedule): string | null {
  return scheduledTime(showId, date, slot, history);
}

/**
 * When the schedule covers this date and only one performance plays, that
 * slot (BRO-6783 auto-select); otherwise null.
 */
export function onlyPerformanceSlot(showId: string, date: string, history?: ShowSchedule): 'matinee' | 'evening' | null {
  const m = scheduledTime(showId, date, 'matinee', history);
  const e = scheduledTime(showId, date, 'evening', history);
  if (m && !e && isKnownDarkForSlot(showId, date, 'evening', history)) return 'matinee';
  if (e && !m && isKnownDarkForSlot(showId, date, 'matinee', history)) return 'evening';
  return null;
}

/**
 * True when only the past-week archive (BRO-6877,
 * /data/show-schedule-history.json) can cover this date: a week that has
 * started that the live schedule no longer carries for this show (a past
 * week, or a show that closed this week).
 */
export function needsScheduleHistory(showId: string, date: string): boolean {
  if (!date) return false;
  const key = mondayOfWeekYyyymmdd(date);
  return key <= schedules.currentMonday && !getShowSchedule(showId)?.weeks[key];
}

/**
 * The day's {m, e} from the live schedule, else from the past-week archive
 * the caller loaded for this show (optional; never bundled).
 */
function dayFor(showId: string, date: string, history?: ShowSchedule) {
  const key = mondayOfWeekYyyymmdd(date);
  const idx = weekdayIndexMonFirst(date);
  return getShowSchedule(showId)?.weeks[key]?.[idx] ?? history?.weeks[key]?.[idx];
}

function scheduledTime(showId: string, date: string, slot: 'matinee' | 'evening', history?: ShowSchedule): string | null {
  const day = dayFor(showId, date, history);
  return (slot === 'matinee' ? day?.m : day?.e) ?? null;
}

