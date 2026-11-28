'use strict';
/**
 * Pre-fetch "URL year is far from this show's opening year" rejection used by replay-pending-bylines.js.
 * BRO-7930: the old inline check read ANY 4-digit 19xx/20xx token after a slash, so the slug
 * "/1984-review-a-clever-take-on-orwells-classic" of the show "1984" (opened 2014) counted as "year 1984" and a real
 * Times review was DELETED from _pending (3 files in the first real run). A number that is part of the show's own
 * title is not a date.
 * @returns {string|null} the offending year, or null when the url carries no conflicting year
 */
function urlYearConflict(url, openingYear, title) {
  if (!openingYear || !url) return null;
  const m = String(url).match(/\/((?:19|20)\d{2})\b/);
  if (!m) return null;
  const year = m[1];
  if (new RegExp(`(?:^|[^0-9])${year}(?:[^0-9]|$)`).test(String(title || ''))) return null; // "1984", "1776", "2000 Years"
  return Math.abs(parseInt(year, 10) - openingYear) > 1 ? year : null;
}
module.exports = { urlYearConflict };
