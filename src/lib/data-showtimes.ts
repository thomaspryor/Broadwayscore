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
 */
export function resolveShowtimeDefault(showId: string, date: string, slot: 'matinee' | 'evening'): string {
  const schedule = getShowSchedule(showId);
  const week = schedule?.weeks[mondayOfWeekYyyymmdd(date)];
  const day = week?.[weekdayIndexMonFirst(date)];
  const scheduled = slot === 'matinee' ? day?.m : day?.e;
  return scheduled || GENERIC_SLOT_TIME[slot];
}

