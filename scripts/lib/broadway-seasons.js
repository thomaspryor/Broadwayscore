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
  // Parse a plain "YYYY-MM-DD" string's components directly rather than via
  // `new Date(str)` + local getters: `new Date("2026-07-01")` parses as UTC
  // midnight, which reads back as "2026-06-30T20:00" in America/New_York —
  // June, not July — silently misclassifying any show that opened exactly on
  // the season-boundary date into the PRIOR season (ship-check finding,
  // 2026-08-30: reproduces the exact cross-season-mix bug this file exists
  // to prevent, just shifted one day earlier). Date objects (already in
  // local time, no string to reparse) keep using the getters below.
  // Also matches an ISO-datetime string with a "YYYY-MM-DD" date component
  // ("2026-07-01T00:00:00.000Z") — second-opinion review finding, 2026-08-30:
  // without the optional `T...` suffix, a datetime string fell through to the
  // `new Date()` branch below and reproduced the exact bug this function
  // exists to fix, just for a slightly different input shape.
  const isoMatch = typeof dateInput === 'string' && /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(dateInput);
  let year, month;
  if (isoMatch) {
    const [, y, m] = isoMatch;
    year = Number(y);
    month = Number(m) - 1; // 0-indexed, matches Date#getMonth() below
    if (month < 0 || month > 11) throw new Error(`Invalid date: ${dateInput}`);
  } else {
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date: ${dateInput}`);
    }
    year = date.getFullYear();
    month = date.getMonth(); // 0-indexed (0 = January, 6 = July)
  }

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
  // Delegate to getSeasonForDate + string equality rather than comparing
  // Date objects across representations: dateInput (parsed as UTC when it's
  // a "YYYY-MM-DD" string) vs getSeasonDates' boundaries (constructed in
  // local time) disagreed by up to a day at the season boundary itself —
  // isDateInSeason('2026-07-01', '2026-2027') returned false (test caught
  // this, 2026-08-30, while adding coverage for the getSeasonForDate fix).
  //
  // getSeasonForDate throws on unparseable input (by design, for callers
  // that need to fail loud) — but isDateInSeason's own contract is a plain
  // boolean (its old Date-range-comparison implementation returned false for
  // an invalid date, never threw). Preserve that: an unparseable dateInput
  // just isn't in any season (second-opinion review finding, 2026-08-30).
  try {
    return getSeasonForDate(dateInput) === season;
  } catch {
    return false;
  }
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

/**
 * Whether the newsletter's "New Plays This Season" / "New Musicals This
 * Season" card should be computed for this opening event at all.
 *
 * Reopenings are excluded (BRO-2564). The card's peer list is built by
 * filtering ALL shows on their own (original) openingDate falling in the
 * target season — so keying just the TARGET season off reopeningDate while
 * leaving peer selection on openingDate would exclude the reopening show
 * from its own peer list (its stale original openingDate falls outside the
 * corrected season boundaries), leaving the card's "how X stacks up"
 * heading pointing at a highlight row that never renders. Redefining peer
 * selection to also key off reopeningDate is possible but adds real
 * complexity for a low-frequency edge case; skipping the card for
 * reopenings avoids the stale-season mixing bug this ticket reports without
 * introducing that new failure mode (second-opinion review finding on the
 * anchor-date approach, 2026-08-31).
 * @param {{isRevival?: boolean}} show
 * @param {boolean} isReopening - true when this week's qualifying event is the reopening
 * @returns {boolean}
 */
function isEligibleForSeasonStanding(show, isReopening) {
  return !show.isRevival && !isReopening;
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
  isEligibleForSeasonStanding,
};
