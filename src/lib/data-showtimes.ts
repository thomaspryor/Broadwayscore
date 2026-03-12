// Showtimes / weekly schedule data module
// Imports: show-schedules.json (~small) for weekly performance schedules

import type { ShowSchedule } from './data-types';
import scheduleData from '../../data/show-schedules.json';

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

/**
 * Check if a show has schedule data
 */
export function hasSchedule(showId: string): boolean {
  return !!schedules.shows[showId];
}
