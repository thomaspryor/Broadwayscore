'use strict';
/**
 * extractDateFromUrl: a review's publish date from its URL. Moved verbatim out of
 * rebuild-helpers.js (which still re-exports it) so light modules such as
 * wrong-production-autoclear.js can read a URL date without pulling rebuild-helpers'
 * require graph, which reaches network code (BRO-6702, safe-form-allowlist graph check).
 */
const { maxPlausibleYear } = require('./date-utils');

// Show-title years that look like dates but aren't
const TITLE_YEARS = new Set(['1776', '1984', '1812', '1921', '1992', '1940', '2026']);

const MONTH_ABBR_TO_NUM = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function validateCalendarDate(year, month, day) {
  if (year < 1970 || year > maxPlausibleYear({ atLeast: 2027 }) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Extract a publish date from a review URL. Returns { date, source } or null.
 * date is YYYY-MM-DD for full dates, YYYY-MM for month-only, or null.
 * yearOnly is set when only a year could be extracted (for wrong-production flagging).
 */
function extractDateFromUrl(url) {
  if (!url) return null;
  const pathOnly = url.split('?')[0].split('#')[0];

  // Pattern 1: /YYYY/MM/DD/ (WordPress-style, most reliable)
  const slashMatch = pathOnly.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  // A full /YYYY/MM/DD/ from 2000 on is a date even when YYYY is a title year: the
  // guard dropped every /2026/MM/DD/ URL date (BRO-6585). Older title years
  // (/1984/07/14/) and the bare-year pattern keep it.
  if (slashMatch && (!TITLE_YEARS.has(slashMatch[1]) || parseInt(slashMatch[1]) >= 2000)) {
    const result = validateCalendarDate(parseInt(slashMatch[1]), parseInt(slashMatch[2]), parseInt(slashMatch[3]));
    if (result) return { date: result, source: 'url-ymd' };
  }

  // Pattern 2: /YYYY/mon/DD (Guardian-style: /2018/apr/22)
  const guardianMatch = pathOnly.match(/\/(20\d\d)\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})/i);
  if (guardianMatch) {
    const month = MONTH_ABBR_TO_NUM[guardianMatch[2].toLowerCase()];
    if (month) {
      const result = validateCalendarDate(parseInt(guardianMatch[1]), parseInt(month), parseInt(guardianMatch[3]));
      if (result) return { date: result, source: 'url-guardian' };
    }
  }

  // Pattern 3: YYYYMMDD at end of URL path (BWW-style: -20241010)
  const bwwMatch = pathOnly.match(/[^0-9](20\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/);
  if (bwwMatch) {
    const result = validateCalendarDate(parseInt(bwwMatch[1]), parseInt(bwwMatch[2]), parseInt(bwwMatch[3]));
    if (result) return { date: result, source: 'url-compact' };
  }

  // Pattern 4: YYYY-MM-DD in path (Bloomberg, LA Times)
  const dashMatch = pathOnly.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dashMatch && (!TITLE_YEARS.has(dashMatch[1]) || parseInt(dashMatch[1]) >= 2000)) {
    const y = parseInt(dashMatch[1]), m = parseInt(dashMatch[2]), d = parseInt(dashMatch[3]);
    // Reject if it doesn't look like a date (e.g., 1776-10-17 is a title year pattern)
    if (y >= 2000 && y <= maxPlausibleYear({ atLeast: 2027 })) {
      const result = validateCalendarDate(y, m, d);
      if (result) return { date: result, source: 'url-dash' };
    }
  }

  // Pattern 5: blogspot.com/YYYY/MM/ (year+month only)
  const blogspotMatch = pathOnly.match(/\.blogspot\.com\/(\d{4})\/(\d{2})\//);
  if (blogspotMatch) {
    const y = parseInt(blogspotMatch[1]), m = parseInt(blogspotMatch[2]);
    if (y >= 2000 && y <= maxPlausibleYear({ atLeast: 2027 }) && m >= 1 && m <= 12) {
      return { date: `${y}-${String(m).padStart(2, '0')}`, source: 'url-blogspot-ym' };
    }
  }

  // Pattern 6: Talkin' Broadway off-broadway section — /ob/MM_DD_YY.html or
  // /page/ob/MM_DD_YY.html, optional trailing letter for same-day multi-review
  // disambiguation (02_08_24b.html). Scoped to the domain since the shape is
  // generic. TB has been behind a Cloudflare managed challenge since ~2026-04
  // (fetchPage can't reach it — see collect-review-texts.js), so this URL-only
  // path is the only viable date source for TB off-broadway reviews.
  if (/talkinbroadway\.com/i.test(url)) {
    const tbMatch = pathOnly.match(/\/(?:page\/)?ob\/(\d{1,2})_(\d{1,2})_(\d{2})[a-z]?\.html/i);
    if (tbMatch) {
      const month = parseInt(tbMatch[1], 10);
      const day = parseInt(tbMatch[2], 10);
      const yy = parseInt(tbMatch[3], 10);
      const year = yy <= 30 ? 2000 + yy : 1900 + yy;
      const result = validateCalendarDate(year, month, day);
      if (result) return { date: result, source: 'url-tb-ob' };
    }
  }

  // Pattern 7: Year-only extraction (for wrong-production flagging, not display)
  // Look for /YYYY/ bounded by path separators
  const yearMatch = pathOnly.match(/\/(20\d\d)\//);
  if (yearMatch && !TITLE_YEARS.has(yearMatch[1])) {
    const y = parseInt(yearMatch[1]);
    if (y >= 2000 && y <= maxPlausibleYear({ atLeast: 2027 })) {
      return { date: null, yearOnly: y, source: 'url-year-only' };
    }
  }

  return null;
}

module.exports = { extractDateFromUrl };
