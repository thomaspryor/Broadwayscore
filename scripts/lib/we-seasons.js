/**
 * West End Season Utilities
 *
 * West End seasons run from September 1 through August 31 (plan v2.2 S0,
 * item 1) — mirrors scripts/lib/broadway-seasons.js's shape but with a
 * different fiscal boundary. No Tony-style eligibility cutoff (Olivier
 * eligibility windows are handled separately, in we-historical-corroboration.js).
 *
 * Examples:
 * - 2024-2025 season: Sept 1, 2024 - Aug 31, 2025
 * - A show opening March 15, 2025 is in the 2024-2025 season
 * - A show opening Sept 15, 2025 is in the 2025-2026 season
 */

/**
 * Parse a date input as a LOCAL calendar date. Plain `new Date("YYYY-MM-DD")`
 * parses as UTC midnight, which shifts to the previous calendar day in any
 * timezone west of UTC (e.g. a show opening exactly "2024-09-01" lands at
 * Aug 31 20:00 EDT) — silently misclassifying season-boundary openings.
 * @param {string|Date} dateInput
 * @returns {Date}
 */
function parseLocalDate(dateInput) {
  if (dateInput instanceof Date) return dateInput;
  const m = typeof dateInput === 'string' && dateInput.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  return new Date(dateInput);
}

/**
 * Get the WE season for a given date
 * @param {string|Date} dateInput - Date string (YYYY-MM-DD) or Date object
 * @returns {string} Season in "YYYY-YYYY" format (e.g., "2024-2025")
 */
function getSeasonForDate(dateInput) {
  const date = parseLocalDate(dateInput);

  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${dateInput}`);
  }

  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed (0 = January, 8 = September)

  // September (8) through December (11) = first year of season
  // January (0) through August (7) = second year of season
  if (month >= 8) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

/**
 * Get start and end dates for a WE season
 * @param {string} season - Season in "YYYY-YYYY" format
 * @returns {{ start: Date, end: Date }}
 */
function getSeasonDates(season) {
  const match = season.match(/^(\d{4})-(\d{4})$/);
  if (!match) {
    throw new Error(`Invalid season format: ${season}. Expected "YYYY-YYYY"`);
  }

  const startYear = parseInt(match[1]);
  const endYear = parseInt(match[2]);

  if (endYear !== startYear + 1) {
    throw new Error(`Invalid season: ${season}. Years must be consecutive.`);
  }

  return {
    start: new Date(startYear, 8, 1),   // Sept 1
    end: new Date(endYear, 7, 31),      // Aug 31
  };
}

/**
 * Check if a date falls within a WE season
 * @param {string|Date} dateInput - Date to check
 * @param {string} season - Season in "YYYY-YYYY" format
 * @returns {boolean}
 */
function isDateInSeason(dateInput, season) {
  const date = parseLocalDate(dateInput);
  const { start, end } = getSeasonDates(season);

  return date >= start && date <= end;
}

/**
 * Get the current WE season
 * @returns {string} Current season in "YYYY-YYYY" format
 */
function getCurrentSeason() {
  return getSeasonForDate(new Date());
}

/**
 * Parse a season string into start/end years
 * @param {string} season - Season in "YYYY-YYYY" format
 * @returns {{ startYear: number, endYear: number }}
 */
function parseSeasonYears(season) {
  const match = season.match(/^(\d{4})-(\d{4})$/);
  if (!match) {
    throw new Error(`Invalid season format: ${season}`);
  }

  return {
    startYear: parseInt(match[1]),
    endYear: parseInt(match[2]),
  };
}

/**
 * Get a list of seasons from start to end (inclusive)
 * @param {string} startSeason - First season
 * @param {string} endSeason - Last season
 * @returns {string[]} Array of seasons
 */
function getSeasonRange(startSeason, endSeason) {
  const start = parseSeasonYears(startSeason);
  const end = parseSeasonYears(endSeason);

  const seasons = [];
  for (let year = start.startYear; year <= end.startYear; year++) {
    seasons.push(`${year}-${year + 1}`);
  }

  return seasons;
}

/**
 * Validate a season string format
 * @param {string} season - Season to validate
 * @returns {{ isValid: boolean, reason?: string }}
 */
function validateSeason(season) {
  const match = season.match(/^(\d{4})-(\d{4})$/);

  if (!match) {
    return { isValid: false, reason: 'Must be in YYYY-YYYY format' };
  }

  const startYear = parseInt(match[1]);
  const endYear = parseInt(match[2]);

  if (endYear !== startYear + 1) {
    return { isValid: false, reason: 'Years must be consecutive (e.g., 2024-2025)' };
  }

  if (startYear < 1900 || startYear > 2100) {
    return { isValid: false, reason: 'Year out of reasonable range' };
  }

  return { isValid: true };
}

/**
 * Format a date range as a season display string
 * @param {string} openingDate - Opening date
 * @param {string} closingDate - Closing date (optional)
 * @returns {string} Display string like "2024-2025 Season" or "Opened 2024-2025"
 */
function formatSeasonDisplay(openingDate, closingDate) {
  const openSeason = getSeasonForDate(openingDate);

  if (!closingDate) {
    return `${openSeason} Season (Running)`;
  }

  const closeSeason = getSeasonForDate(closingDate);

  if (openSeason === closeSeason) {
    return `${openSeason} Season`;
  }

  return `${openSeason} - ${closeSeason} Seasons`;
}

module.exports = {
  getSeasonForDate,
  getSeasonDates,
  isDateInSeason,
  getCurrentSeason,
  parseSeasonYears,
  getSeasonRange,
  validateSeason,
  formatSeasonDisplay,
};
