/**
 * Shared date parsing utilities for the review pipeline.
 *
 * Every script that parses a publishDate from review-text JSON files should use
 * normalizeDate() instead of inline ordinal-stripping + new Date().
 *
 * Handles:
 *  - Ordinal suffixes: "February 11th, 2026" → "February 11, 2026"
 *  - UK date format: "11 February 2026" → valid Date
 *  - ISO timestamps: "2026-02-11T05:00:00Z" → "2026-02-11"
 *  - Already-normalized: "2026-02-11" → pass-through
 *  - Sentinel strings: "For a previous production" → null
 *  - Invalid dates: "March 32, 2011" → null (not silently wrong)
 */

'use strict';

const MONTH_TO_NUM = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

const MONTH_ABBR_TO_NUM = {
  jan: '01', feb: '02', mar: '03', apr: '04',
  may: '05', jun: '06', jul: '07', aug: '08',
  sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Strip ordinal suffixes from a date string.
 * "February 11th, 2026" → "February 11, 2026"
 * "22nd March 2025" → "22 March 2025"
 *
 * @param {string} dateStr
 * @returns {string}
 */
function stripOrdinals(dateStr) {
  return dateStr.replace(/(\d+)(?:st|nd|rd|th)\b/gi, '$1');
}

/**
 * Validate that year/month/day form a real calendar date.
 * Returns YYYY-MM-DD string or null.
 *
 * @param {number} year
 * @param {number} month - 1-indexed (1=Jan, 12=Dec)
 * @param {number} day
 * @returns {string|null}
 */
function validateCalendarDate(year, month, day) {
  if (year < 1970 || year > 2030 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parse a date string into a YYYY-MM-DD string.
 *
 * Returns null for unparseable or sentinel values.
 * Uses explicit pattern matching (not new Date()) for formats that commonly fail.
 *
 * @param {string|null|undefined} dateStr - Raw date string from review data
 * @returns {string|null} - YYYY-MM-DD or null
 */
function normalizeDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;

  const trimmed = dateStr.trim();

  // Sentinel / non-date strings
  if (/previous production/i.test(trimmed)) return null;

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    // Validate it's a real date
    const [y, m, d] = trimmed.split('-').map(Number);
    return validateCalendarDate(y, m, d);
  }

  // ISO timestamp: 2026-02-11T05:00:00Z → 2026-02-11
  const isoTs = trimmed.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoTs) {
    const [y, m, d] = isoTs[1].split('-').map(Number);
    return validateCalendarDate(y, m, d);
  }

  // Strip ordinals before pattern matching
  const cleaned = stripOrdinals(trimmed);

  // US format: "Month DD, YYYY" or "Month DD YYYY"
  const mdy = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdy) {
    const monthNum = MONTH_TO_NUM[mdy[1].toLowerCase()] || MONTH_ABBR_TO_NUM[mdy[1].toLowerCase()];
    if (monthNum) {
      return validateCalendarDate(Number(mdy[3]), Number(monthNum), Number(mdy[2]));
    }
  }

  // UK format: "DD Month YYYY"
  const dmy = cleaned.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (dmy) {
    const monthNum = MONTH_TO_NUM[dmy[2].toLowerCase()] || MONTH_ABBR_TO_NUM[dmy[2].toLowerCase()];
    if (monthNum) {
      return validateCalendarDate(Number(dmy[3]), Number(monthNum), Number(dmy[1]));
    }
  }

  // Fallback: strip ordinals and try new Date()
  const parsed = new Date(cleaned);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * Parse a date string into a Date object.
 * Convenience wrapper around normalizeDate() for code that needs Date objects.
 *
 * @param {string|null|undefined} dateStr
 * @returns {Date|null}
 */
function parseDate(dateStr) {
  const normalized = normalizeDate(dateStr);
  if (!normalized) return null;
  return new Date(normalized + 'T00:00:00Z');
}

/**
 * Strip ordinal suffixes and parse into a Date object, WITHOUT normalizeDate()'s
 * 1970-2030 calendar-year floor (validateCalendarDate). Use this instead of
 * parseDate() for code that scans pre-2005/historical shows, where a genuine
 * 1950s-1960s review publishDate would otherwise silently become null.
 *
 * @param {string|null|undefined} dateStr
 * @returns {Date|null}
 */
function parseHistoricalDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const d = new Date(stripOrdinals(dateStr.trim()));
  return isNaN(d.getTime()) ? null : d;
}

module.exports = { normalizeDate, parseDate, parseHistoricalDate, stripOrdinals, validateCalendarDate };
