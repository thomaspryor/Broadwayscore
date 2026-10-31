'use strict';

/**
 * Last-resort opening date for a live show that never got one.
 *
 * Listing sources (TodayTix, venue pages, Playbill production pages) give a
 * first-performance date; only some later source gives the press night. When
 * that later source never matches the show, openingDate stays null forever,
 * the show sits at status=previews, and every review gate treats it as "not
 * opened" (our-sinatra-a-musical-celebration-off-broadway-2026, 2026-09-27:
 * performing since 09-11, zero reviews on the site until fixed by hand).
 *
 * Once previews have run PREVIEWS_FALLBACK_GRACE_DAYS with still no opening
 * date, use the first-performance date. It is written with source
 * 'previews-fallback', which date-source-confidence.js treats as unconfirmed,
 * so enrich-off-broadway-dates / enrich-west-end-dates overwrite it the
 * moment Playbill or another trusted source has the real press night (their
 * same-date fix handles exactly openingDate === previewsStartDate).
 *
 * Scope: off-broadway and off-west-end only. Opening-night email broadcasts
 * select exact 'broadway' / 'west-end' shows by openingDate
 * (send-opening-night-broadcast.js findRecentlyOpenedShows), so a guessed
 * date there could email subscribers about a non-opening (CLAUDE.md §17).
 * Those markets also have authoritative date sources (IBDB, Theatremonkey).
 */

const PREVIEWS_FALLBACK_GRACE_DAYS = 7;
// Older than this and it's an attraction / long-running listing with no
// press night at all (armory tours, Shrek's Adventure); leave it alone.
const PREVIEWS_FALLBACK_MAX_AGE_DAYS = 120;
const FALLBACK_CATEGORIES = new Set(['off-broadway', 'off-west-end']);
const PREVIEWS_FALLBACK_SOURCE = 'previews-fallback';

function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.floor((b - a) / 86400000);
}

/**
 * @param {object} show - shows.json entry
 * @param {string} todayStr - YYYY-MM-DD
 * @returns {{openingDate: string, openingDateSource: string}|null}
 */
function previewsFallbackOpening(show, todayStr) {
  if (!show || show.openingDate) return null;
  if (!FALLBACK_CATEGORIES.has(show.category)) return null;
  if (show.status !== 'previews' && show.status !== 'open') return null;
  const start = show.previewsStartDate;
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const age = daysBetween(start, todayStr);
  if (!Number.isFinite(age)) return null;
  if (age < PREVIEWS_FALLBACK_GRACE_DAYS || age > PREVIEWS_FALLBACK_MAX_AGE_DAYS) return null;
  return { openingDate: start, openingDateSource: PREVIEWS_FALLBACK_SOURCE };
}

module.exports = {
  PREVIEWS_FALLBACK_GRACE_DAYS,
  PREVIEWS_FALLBACK_MAX_AGE_DAYS,
  PREVIEWS_FALLBACK_SOURCE,
  previewsFallbackOpening,
};
