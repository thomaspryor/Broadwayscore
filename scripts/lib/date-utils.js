/**
 * Shared date parsing utilities for the review pipeline.
 *
 * Every script that parses a publishDate from review-text JSON files should use
 * normalizeDate() instead of inline ordinal-stripping + new Date().
 *
 * Handles:
 *  - Ordinal suffixes: "February 11th, 2026" → "February 11, 2026"
 *  - UK date format: "11 February 2026" → valid Date
 *  - ISO timestamps: "2026-02-11T05:00:00Z" → "2026-02-11" (the calendar day in
 *    the market's time zone, BRO-7890; see normalizeDate's opts)
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
 * Latest year a parsed publish/URL date may carry: next calendar year, but never
 * below `atLeast` (the old literal cap at that site), so today's behaviour is
 * unchanged and the cap no longer expires. BRO-5261 S11: eight-plus parsers
 * hard-coded 2027/2028/2030 and would silently drop every later date.
 * @param {{atLeast?: number}} [opts]
 */
function maxPlausibleYear({ atLeast = 0 } = {}) {
  return Math.max(atLeast, new Date().getFullYear() + 1);
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
  if (year < 1970 || year > maxPlausibleYear({ atLeast: 2030 }) || month < 1 || month > 12 || day < 1 || day > 31) return null;
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
// BRO-7890: a zoned instant ("2026-11-20T03:00:00Z", "Wed, 19 Nov 2026 22:00:00 -0500") is
// converted to the market's calendar day, never the UTC day. A New York review posted at
// 10pm ET is 03:00Z the next day; taking the UTC date stored it a day late.
const ZONED_TIME_RE = /\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[AP]\.?M\.?\s*)?(?:Z\b|[+-]\d{2}:?\d{2}\b|\b(?:GMT|UTC|UT|E[SD]T|C[SD]T|M[SD]T|P[SD]T|BST)\b)/i;

function zoneFor(opts) {
  const { tzForMarket } = require('./local-date');
  return (opts && (opts.timeZone || tzForMarket(opts.market))) || undefined;
}

function normalizeDate(dateStr, opts = {}) {
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

  // ISO timestamp: 2026-02-11T05:00:00Z → 2026-02-11. A UTC stamp is converted to the market's
  // calendar day (opts.timeZone, opts.market, else the publisher host in opts.url, else New York);
  // an explicit local offset or a zoneless stamp keeps its written day (local-date.js rules).
  const isoTs = trimmed.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoTs) {
    const { publishedStampToLocalDate } = require('./local-date');
    const local = publishedStampToLocalDate(trimmed, opts && opts.url, { tz: zoneFor(opts) });
    const day = local && /^\d{4}-\d{2}-\d{2}$/.test(local) ? local : isoTs[1];
    const [y, m, d] = day.split('-').map(Number);
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
    // BRO-2844: new Date() rolls an impossible day forward ("February 30,
    // 2022 10:00 AM" -> 2022-03-02) and this branch skips validateCalendarDate.
    // Reject a stated day that does not exist in its stated month. This reads
    // the day from the text, not from `parsed`, so timezone offsets in the
    // string cannot cause a false rejection.
    const stated = cleaned.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?!\d)\D.*?\b((?:19|20)\d{2})\b/);
    if (stated) {
      const mn = MONTH_TO_NUM[stated[1].toLowerCase()] || MONTH_ABBR_TO_NUM[stated[1].toLowerCase()];
      if (mn && Number(stated[2]) > new Date(Number(stated[3]), Number(mn), 0).getDate()) return null;
    }
    // BRO-7890: a zoned instant is the market's calendar day; a zoneless written time was parsed in
    // the machine's zone, so its local getters give back the day that was written (never the UTC day).
    if (ZONED_TIME_RE.test(cleaned)) {
      // Only a UTC-written midnight is a date-only value; "19 Nov 2026 19:00 -0500" is 00:00Z but a real evening time.
      const { localDateString, tzForUrl } = require('./local-date');
      const utcWritten = /(?:\bZ\b|[+-]00:?00\b|\b(?:GMT|UTC|UT)\b)/i.test(cleaned);
      if (utcWritten && parsed.getUTCHours() === 0 && parsed.getUTCMinutes() === 0 && parsed.getUTCSeconds() === 0) return parsed.toISOString().slice(0, 10);
      return localDateString(parsed, zoneFor(opts) || tzForUrl(opts && opts.url));
    }
    return validateCalendarDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
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

/**
 * Epoch ms for any publishDate-ish value; NaN when unreadable. THE one place
 * guards should turn a review/show date into a number (BRO-2836: raw
 * `new Date("April 11th, 2024")` is Invalid, so every window check built on it
 * silently declined to fire for the ~13% of reviews with ordinal dates).
 *
 * Whatever native Date already parsed keeps its exact old value (zero drift for
 * ISO / "April 11, 2024"); only previously-NaN strings reach the ordinal-safe
 * fallbacks. null/undefined/'' are NaN (never epoch 0).
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {number}
 */
function toDateMs(value) {
  if (value == null || value === '') return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const native = new Date(value).getTime();
  if (!isNaN(native)) return native;
  // Same clock as the native parse: "November 17th, 2023" must equal
  // "November 17, 2023" (local midnight). parseDate is UTC midnight, so it
  // only agreed on a UTC machine (orphan-review-folders test, BRO-5280).
  const stripped = new Date(stripOrdinals(value.trim())).getTime();
  if (!isNaN(stripped)) return stripped;
  const d = parseDate(value) || parseHistoricalDate(value);
  return d ? d.getTime() : NaN;
}

/**
 * BRO-7890: the shape of a stored review publishDate. 'day' = YYYY-MM-DD, 'month' = YYYY-MM (a deliberate
 * month-only date), 'other' = anything else (a raw timestamp, a written date): never valid in reviews.json.
 */
function classifyPublishDateFormat(value) {
  const s = String(value == null ? '' : value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'day';
  if (/^\d{4}-\d{2}$/.test(s)) return 'month';
  return 'other';
}

module.exports = { classifyPublishDateFormat, maxPlausibleYear, normalizeDate, parseDate, parseHistoricalDate, stripOrdinals, validateCalendarDate, toDateMs };
