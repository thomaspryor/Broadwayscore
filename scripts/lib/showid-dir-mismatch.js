'use strict';

/**
 * Pre-pass 1 of audit-cross-show-url-collisions.js flags wrongProduction on any
 * review file whose `showId` field disagrees with its directory. The rebuild
 * treats the directory as authoritative and its UK/London auto-clear removes
 * that flag again the same night, so a file whose `showId` field is the stale
 * one flapped daily: flagged at collect, cleared at rebuild, flagged again
 * (BRO-7579: 17 files, the-comedy-about-spies-west-end-2025 and
 * into-the-woods-off-west-end-2025, carrying the later same-title run's id).
 * Each flap left contentTier 'invalid', which the Critics' Take inputs drop
 * while the rebuild still ships the row (REVIEWCOUNT_DRIFT 36 vs 25).
 *
 * staleFileShowId says the FIELD is wrong, not the folder: both ids are real
 * runs of the same title, and the review's own publishDate falls inside the
 * directory run's window and outside the file-id run's window. Pure; dates
 * and titles only (never URL metadata, CLAUDE.md §3).
 */

const { parseDate } = require('./date-utils');
const { earliestShowDate } = require('./date-guard');
const { foldDiacritics } = require('./title-match');

const DAY_MS = 86400000;
// Reviews land a few days either side of the run (preview-week notices, late
// write-ups). Small on purpose: two same-title runs are usually months apart.
const WINDOW_SLACK_DAYS = 14;

const normTitle = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function inRunWindow(dateMs, show) {
  const start = parseDate(earliestShowDate(show));
  if (!start) return false;
  if (dateMs < start.getTime() - WINDOW_SLACK_DAYS * DAY_MS) return false;
  const close = parseDate(show.closingDate);
  return !close || dateMs <= close.getTime() + WINDOW_SLACK_DAYS * DAY_MS;
}

/**
 * @param {{data: object, dirShow: object|undefined, fileShow: object|undefined}} args
 *   data: the review file; dirShow / fileShow: shows.json entries for the
 *   directory id and the file's showId field.
 * @returns {boolean} true when the file's showId field is the stale side
 */
function staleFileShowId({ data, dirShow, fileShow }) {
  if (!data || !dirShow || !fileShow || dirShow.id === fileShow.id) return false;
  if (!normTitle(dirShow.title) || normTitle(dirShow.title) !== normTitle(fileShow.title)) return false;
  const pub = parseDate(data.publishDate);
  if (!pub) return false;
  const t = pub.getTime();
  return inRunWindow(t, dirShow) && !inRunWindow(t, fileShow);
}

module.exports = { staleFileShowId, WINDOW_SLACK_DAYS };
