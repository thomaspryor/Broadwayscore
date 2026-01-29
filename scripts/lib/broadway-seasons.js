/**
 * Broadway Season Utilities
 *
 * Broadway seasons run from July 1 through June 30.
 * Tony eligibility typically requires opening by late April.
 *
 * Examples:
 * - 2024-2025 season: July 1, 2024 - June 30, 2025
 * - A show opening March 15, 2025 is in the 2024-2025 season
 * - A show opening July 15, 2025 is in the 2025-2026 season
 */

/**
 * Get the Broadway season for a given date
 * @param {string|Date} dateInput - Date string (YYYY-MM-DD) or Date object
 * @returns {string} Season in "YYYY-YYYY" format (e.g., "2024-2025")
 */
function getSeasonForDate(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);

  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${dateInput}`);
  }

  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed (0 = January, 6 = July)

  // July (6) through December (11) = first year of season
  // January (0) through June (5) = second year of season
  if (month >= 6) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

/**
 * Get start and end dates for a Broadway season
 * @param {string} season - Season in "YYYY-YYYY" format
 * @returns {{ start: Date, end: Date, tonyEligibilityCutoff: Date }}
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
    start: new Date(startYear, 6, 1), // July 1
    end: new Date(endYear, 5, 30),    // June 30
    // Tony eligibility typically late April
    tonyEligibilityCutoff: new Date(endYear, 3, 25), // April 25
  };
}

/**
 * Check if a date falls within a Broadway season
 * @param {string|Date} dateInput - Date to check
 * @param {string} season - Season in "YYYY-YYYY" format
 * @returns {boolean}
 */
function isDateInSeason(dateInput, season) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const { start, end } = getSeasonDates(season);

  return date >= start && date <= end;
}

/**
 * Get the current Broadway season
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
    endYear: parseInt(match[2])
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
