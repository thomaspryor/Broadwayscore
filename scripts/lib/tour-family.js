'use strict';

/**
 * Tour family (BRO-4262): which national tour, if any, a review of a Broadway
 * title belongs to. One place for the date-window rule so intake routing
 * (market-routing.js), the sweep (tour-backfill.js) and auto-create agree.
 *
 * A tour's window runs from a week before its launch (first-stop reviews and
 * roundups can predate the official launch listing) to 60 days after it closes
 * (reviews trail the last stop), and ends early where the next tour of the same
 * title begins. Pure: no I/O.
 */

const DAY = 86400000;
const BEFORE_LAUNCH_SLACK_DAYS = 7;
const AFTER_CLOSE_SLACK_DAYS = 60;

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  // "April 29th, 2019" is Invalid Date as written; drop the ordinal suffix.
  const d = new Date(String(v).replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function isTourShow(show) {
  return Boolean(show) && show.category === 'tour';
}

/**
 * Date window per tour, in launch order. A tour with no launch date gets no
 * window (it can't be told apart from its siblings by date).
 * @param {Array<{id, openingDate?, closingDate?}>} tours tours of ONE title
 * @returns {Array<{id, start: Date|null, end: Date|null, open: boolean}>}
 */
function tourWindows(tours, now = new Date()) {
  const dated = tours
    .map(t => ({ t, launch: toDate(t.openingDate), close: toDate(t.closingDate) }))
    .sort((a, b) => (a.launch ? a.launch.getTime() : Infinity) - (b.launch ? b.launch.getTime() : Infinity));
  return dated.map((d, i) => {
    const next = dated.slice(i + 1).find(x => x.launch);
    let end = d.close ? new Date(d.close.getTime() + AFTER_CLOSE_SLACK_DAYS * DAY) : null;
    if (next) {
      const cut = new Date(next.launch.getTime() - BEFORE_LAUNCH_SLACK_DAYS * DAY);
      if (!end || cut < end) end = cut;
    }
    return {
      id: d.t.id,
      start: d.launch ? new Date(d.launch.getTime() - BEFORE_LAUNCH_SLACK_DAYS * DAY) : null,
      end,
      open: !d.close || d.close > now,
    };
  });
}

/**
 * Pick the tour a review belongs to.
 * A date taken from the URL (dateSource 'url') is not trusted: URLs are
 * inconsistent (CLAUDE.md §3), so the review is treated as undated.
 * Undated reviews go to a tour only when the title has exactly one tour and it
 * is still running; anything else is ambiguous and returns null.
 *
 * @param {Array} tours tours of the review's title (category 'tour')
 * @param {{publishDate?, dateSource?}} review
 * @returns {{tourId: string|null, reason: string}}
 */
function pickTourForDate(tours, review = {}, now = new Date()) {
  if (!Array.isArray(tours) || tours.length === 0) return { tourId: null, reason: 'no-tour' };
  const windows = tourWindows(tours, now);
  const pub = review.dateSource === 'url' ? null : toDate(review.publishDate);
  if (!pub) {
    if (windows.length === 1 && windows[0].open) return { tourId: windows[0].id, reason: 'undated-single-running-tour' };
    return { tourId: null, reason: 'undated-ambiguous' };
  }
  const hits = windows.filter(w => w.start && pub >= w.start && (!w.end || pub <= w.end));
  if (hits.length === 1) return { tourId: hits[0].id, reason: 'in-tour-window' };
  if (hits.length > 1) return { tourId: null, reason: 'overlapping-tours' };
  return { tourId: null, reason: 'outside-tour-windows' };
}

const normTitle = (t) => String(t || '').trim().toLowerCase().replace(/[!?.,'"]/g, '');

/** Every tour entry whose title matches (tours carry their parent's title). */
function toursOfTitle(title, shows) {
  const t = normTitle(title);
  if (!t) return [];
  return (shows || []).filter(s => isTourShow(s) && normTitle(s.title) === t);
}

/**
 * The one tour of this show's title that is running now, or null (none, or
 * more than one so the choice would be a guess). For undated inputs such as a
 * roundup found on a landing page.
 */
function runningTourFor(show, shows, now = new Date()) {
  const pick = pickTourForDate(toursOfTitle(show && show.title, shows), {}, now);
  return pick.tourId;
}

/**
 * What a tour borrows from its Broadway parent when it has nothing of its own
 * (BRO-4262): the parent's archived thumbnail and poster (key art is shared
 * across a show's productions) and its synopsis (same story). Never the hero:
 * that is usually a Broadway cast photo. Only local archived image paths are
 * copied, so a parent's unverified remote URL never spreads.
 * @returns {object|null} fields to set on the tour, or null when nothing is missing
 */
function tourInheritance(tour, parent) {
  if (!isTourShow(tour) || !parent) return null;
  const patch = {};
  const own = tour.images || {};
  const theirs = parent.images || {};
  const isArchived = v => typeof v === 'string' && v.startsWith('/images/shows/');
  const images = {};
  for (const k of ['thumbnail', 'poster']) {
    if (!own[k] && isArchived(theirs[k])) images[k] = theirs[k];
  }
  if (Object.keys(images).length) patch.images = { hero: own.hero || null, ...own, ...images };
  if (!tour.synopsis && parent.synopsis) patch.synopsis = parent.synopsis;
  return Object.keys(patch).length ? patch : null;
}

/** Apply tourInheritance to every tour in place. Returns the ids changed. */
function applyTourInheritance(shows) {
  const byId = new Map((shows || []).map(s => [s.id, s]));
  const changed = [];
  for (const tour of (shows || []).filter(isTourShow)) {
    const patch = tourInheritance(tour, byId.get(tour.tourOf));
    if (!patch) continue;
    Object.assign(tour, patch);
    changed.push(tour.id);
  }
  return changed;
}

module.exports = {
  isTourShow,
  tourInheritance,
  applyTourInheritance,
  toursOfTitle,
  runningTourFor,
  tourWindows,
  pickTourForDate,
  BEFORE_LAUNCH_SLACK_DAYS,
  AFTER_CLOSE_SLACK_DAYS,
};
