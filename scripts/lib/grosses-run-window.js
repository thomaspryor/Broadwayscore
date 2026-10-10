'use strict';
/**
 * Which production a weekly Broadway grosses row belongs to (BRO-5016).
 *
 * A League row is for one week ending on a Sunday. It belongs to the shows.json
 * entry whose run (first preview to closing) contains that week. Every
 * production of a title used to share one key in grosses-history.json because
 * the matcher's exact-title step never saw a revival listed under a longer
 * title ("Cabaret" vs "Cabaret at the Kit Kat Club"): 24 years of Cabaret weeks
 * sat on cabaret-2014, and the live card summed them.
 *
 * Pure: no I/O.
 */

const DAY_MS = 86400 * 1000;
/** Slack on both ends: a week ending up to 7 days before the first preview or after closing. */
const WINDOW_SLACK_DAYS = 7;
/** Previews assumed when shows.json has an opening date but no previewsStartDate. */
const PREVIEW_WEEKS_IF_UNKNOWN = 4;

function toMs(d) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(d || ''));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * [startMs, endMs] for week-ending dates that can hold this show's grosses, or
 * null when shows.json has neither a previews nor an opening date. A running
 * show (no closingDate) runs to nowMs.
 */
function runWeekWindow(show, nowMs = Date.now()) {
  if (!show) return null;
  const opening = toMs(show.openingDate);
  const start = toMs(show.previewsStartDate) ?? (opening == null ? null : opening - PREVIEW_WEEKS_IF_UNKNOWN * 7 * DAY_MS);
  if (start == null) return null;
  const end = toMs(show.closingDate) ?? nowMs;
  const slack = WINDOW_SLACK_DAYS * DAY_MS;
  return { startMs: start - slack, endMs: end + slack };
}

/** True when the week ending `week` (YYYY-MM-DD) is inside the show's run window; null when the show has no dates. */
function weekInRun(show, week, nowMs = Date.now()) {
  const w = runWeekWindow(show, nowMs);
  const t = toMs(week);
  if (!w || t == null) return null;
  return t >= w.startMs && t <= w.endMs;
}

const NOISE_WORDS = new Set(['the', 'a', 'an', 'musical', 'on', 'broadway']);
const CONNECTORS = new Set(['and', 'of', 'in', 'at', 'to', 'for', 'with', 'or', 'from']);

/** Title as a word list: diacritics, punctuation, "&"/"+" folded, articles and "the musical" dropped. */
function titleWords(title) {
  return String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/\s*[&+]\s*/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !NOISE_WORDS.has(w));
}

/** True when `small` appears as a contiguous run of whole words inside `big`. */
function containsWords(big, small) {
  if (!small.length || small.length > big.length) return false;
  for (let i = 0; i + small.length <= big.length; i++) {
    if (small.every((w, j) => big[i + j] === w)) return true;
  }
  return false;
}

/**
 * Same work, possibly another production: one title's words sit whole inside
 * the other's ("Dancin'" in "Bob Fosse's Dancin'", "Cabaret" in "Cabaret at the
 * Kit Kat Club", "Romeo and Juliet" and "Romeo + Juliet"). Loose on purpose:
 * callers only act when exactly one such production's run contains the week.
 */
function sameWork(a, b) {
  const wa = titleWords(a && a.title);
  const wb = titleWords(b && b.title);
  if (!wa.length || !wb.length) return false;
  const [big, small] = wa.length >= wb.length ? [wa, wb] : [wb, wa];
  // A shorter title that opens or ends on a connector is a fragment, not the
  // work: "& Juliet" is not "Romeo and Juliet".
  if (small.length < big.length && (CONNECTORS.has(small[0]) || CONNECTORS.has(small[small.length - 1]))) return false;
  return containsWords(big, small);
}

const isBroadway = (s) => !s.category || s.category === 'broadway';

/**
 * The single Broadway production of the same work whose run contains `week`,
 * or null when none or more than one does.
 */
function productionForWeek(show, week, shows, nowMs = Date.now()) {
  if (!show) return null;
  const hits = (shows || []).filter((s) => s && isBroadway(s) && (s === show || sameWork(show, s)) && weekInRun(s, week, nowMs) === true);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The production a League row for week `week` belongs to, given the show the
 * title matcher picked: the one same-work production whose run holds the week,
 * else the picked show unless its own run rules the week out (then null, so
 * the row is reported unmatched instead of filed on the wrong run).
 */
function grossesProductionFor(show, week, shows, nowMs = Date.now()) {
  if (!show || !week) return show || null;
  const p = productionForWeek(show, week, shows, nowMs);
  if (p) return p;
  return weekInRun(show, week, nowMs) === false ? null : show;
}

module.exports = {
  grossesProductionFor,
  WINDOW_SLACK_DAYS,
  PREVIEW_WEEKS_IF_UNKNOWN,
  runWeekWindow,
  weekInRun,
  titleWords,
  sameWork,
  productionForWeek,
};
