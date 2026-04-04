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

