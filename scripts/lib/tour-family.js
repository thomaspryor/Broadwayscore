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

// What a tour may descend from (BRO-4931). A tour's parent is any non-tour
// production of the title: Broadway, Off-Broadway, regional, West End or
// Off-West End. A tour with no parent at all (a touring show that never played
// a tracked market first) is standalone: it omits tourOf and carries
// tourScheduleSlug instead.
const TOUR_PARENT_CATEGORIES = ['broadway', 'off-broadway', 'regional', 'west-end', 'off-west-end'];

// What AUTOMATIC discovery may pick as a tour's parent (BRO-4931): a UK
// production is a different show (a London Mousetrap, Choir of Man or Hamnet is
// not the North American tour on the road), so Tours To You pages and BWW
// roundups are matched against these three only. A West End or off-West End
// parent is reached only by a person: an override row in data/tour-page-classes.json
// naming parentId, or a manual add-show (which may use any TOUR_PARENT_CATEGORIES).
const AUTO_TOUR_PARENT_CATEGORIES = ['broadway', 'off-broadway', 'regional'];

/** The tour-parent category of a show (a show with no category is Broadway), or null. */
function tourParentCategory(show) {
  const c = (show && show.category) || 'broadway';
  return TOUR_PARENT_CATEGORIES.includes(c) ? c : null;
}

// "See the <label> production": what a tour's parent link calls its market.
const TOUR_PARENT_LABELS = {
  broadway: 'Broadway',
  'off-broadway': 'Off-Broadway',
  regional: 'regional',
  'west-end': 'West End',
  'off-west-end': 'Off-West End',
};

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
  // Any URL-derived source ('url', 'extracted-from-url', 'url-backfill-*').
  const pub = /url/i.test(String(review.dateSource || '')) ? null : toDate(review.publishDate);
  if (!pub) {
    if (windows.length === 1 && windows[0].open) return { tourId: windows[0].id, reason: 'undated-single-running-tour' };
    return { tourId: null, reason: 'undated-ambiguous' };
  }
  const hits = windows.filter(w => w.start && pub >= w.start && (!w.end || pub <= w.end));
  if (hits.length === 1) return { tourId: hits[0].id, reason: 'in-tour-window' };
  if (hits.length > 1) return { tourId: null, reason: 'overlapping-tours' };
  return { tourId: null, reason: 'outside-tour-windows' };
}

// Curly apostrophes and quotes too: a Tours To You page title has a straight one
// where the show's own title may have a curly one (Dolly Parton's, Dr. Seuss',
// 20 titles at BRO-4931), and the two must name the same title.
const normTitle = (t) => String(t || '').trim().toLowerCase().replace(/[!?.,'"‘’“”ʼ`]/g, '');

/** Every tour entry whose title matches (tours carry their parent's title, or their own when standalone). */
function toursOfTitle(title, shows) {
  const t = normTitle(title);
  if (!t) return [];
  return (shows || []).filter(s => isTourShow(s) && normTitle(s.title) === t);
}

/** Every non-tour production whose title matches: the candidates for a tour's parent. */
function productionsOfTitle(title, shows) {
  const t = normTitle(title);
  if (!t) return [];
  return (shows || []).filter(s => !isTourShow(s) && normTitle(s.title) === t);
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

// A parent closed longer ago than this before the tour launched is probably
// not the production on the road (Mark Twain Tonight!: Hal Holbrook on
// Broadway in 2005, Richard Thomas touring in 2027).
const SAME_PRODUCTION_YEARS = 3;

/**
 * The parent is plausibly the production on the road: still running, closed
 * within SAME_PRODUCTION_YEARS of the tour's launch, or already sent out an
 * earlier tour we track (Shucked's second tour). Without a launch, assumed so.
 */
function sameProductionLikely(tour, parent, shows = null) {
  if (!parent.closingDate || parent.status !== 'closed') return true;
  const launch = toDate(tour.openingDate);
  const closed = toDate(parent.closingDate);
  if (!launch || !closed) return true;
  if (launch.getTime() - closed.getTime() <= SAME_PRODUCTION_YEARS * 365 * DAY) return true;
  return Boolean(shows) && toursOfTitle(tour.title, shows).some(t => t.id !== tour.id && t.openingDate && t.openingDate < tour.openingDate);
}

/**
 * What a tour borrows from its parent (any TOUR_PARENT_CATEGORIES production)
 * when it has nothing of its own (BRO-4262): its synopsis (same story), and,
 * when the parent is plausibly the same production (sameProductionLikely), the
 * parent's archived thumbnail and poster (key art) and its runtime. Never the
 * hero (usually a cast photo) or the cast. A standalone tour has no parent and
 * inherits nothing. Only local archived image paths are copied, so a parent's
 * unverified remote URL never spreads.
 * @param {Array} [shows] all shows, so an earlier tour of the title counts
 * @returns {object|null} fields to set on the tour, or null when nothing is missing
 */
function tourInheritance(tour, parent, shows = null) {
  if (!isTourShow(tour) || !parent || isTourShow(parent)) return null;
  const patch = {};
  if (!tour.synopsis && parent.synopsis) patch.synopsis = parent.synopsis;
  if (!sameProductionLikely(tour, parent, shows)) return Object.keys(patch).length ? patch : null;
  const own = tour.images || {};
  const theirs = parent.images || {};
  const isArchived = v => typeof v === 'string' && v.startsWith('/images/shows/');
  const images = {};
  for (const k of ['thumbnail', 'poster']) {
    if (!own[k] && isArchived(theirs[k])) images[k] = theirs[k];
  }
  if (Object.keys(images).length) patch.images = { hero: own.hero || null, ...own, ...images };
  // Same production on the road, same length: a tour page showed an empty
  // Runtime for 20 of 21 tours (BRO-4601).
  if (!tour.runtime && parent.runtime) patch.runtime = parent.runtime;
  return Object.keys(patch).length ? patch : null;
}

/** Apply tourInheritance to every tour in place. Returns the ids changed. */
function applyTourInheritance(shows) {
  const byId = new Map((shows || []).map(s => [s.id, s]));
  const changed = [];
  for (const tour of (shows || []).filter(isTourShow)) {
    const patch = tourInheritance(tour, byId.get(tour.tourOf), shows);
    if (!patch) continue;
    Object.assign(tour, patch);
    changed.push(tour.id);
  }
  return changed;
}

// A tour id is <base>-tour-<year>: the parent's market never rides along
// (mexodus-off-broadway-2026 tours as mexodus-tour-2026).
const MARKET_BEFORE_TOUR_RE = /-(on-broadway|off-broadway|off-west-end|west-end|regional)-tour-\d{4}$/;

/**
 * Link problems on one tour entry (validate-data.js, BRO-4931), as
 * { level: 'error' | 'warn', msg }. tourOf is optional: present, it names an
 * existing non-tour show; absent (never null), the tour is standalone and
 * needs tourScheduleSlug. Warns when a standalone tour shares a title with a
 * non-tour show (it probably tours that show).
 * @param {object} tour a category:'tour' entry
 * @param {Array} shows all shows
 */
function tourLinkProblems(tour, shows) {
  const out = [];
  if (!isTourShow(tour)) return out;
  if (MARKET_BEFORE_TOUR_RE.test(tour.id)) {
    out.push({ level: 'error', msg: `Tour "${tour.id}" id carries a market before -tour-<year>; a tour id is <base>-tour-<year> (mexodus-off-broadway-2026 tours as mexodus-tour-2026)` });
  }
  if (tour.tourOf === null || tour.tourOf === '') {
    out.push({ level: 'error', msg: `Tour "${tour.id}" has an empty tourOf; omit the field for a standalone tour, never write null` });
  } else if (tour.tourOf === undefined) {
    if (!tour.tourScheduleSlug) out.push({ level: 'error', msg: `Tour "${tour.id}" has no tourOf and no tourScheduleSlug; a standalone tour needs its Tours To You page` });
    const same = productionsOfTitle(tour.title, shows);
    if (same.length) out.push({ level: 'warn', msg: `Tour "${tour.id}" has no tourOf but ${same.length} non-tour show(s) share its title (${same.slice(0, 3).map(o => o.id).join(', ')}); set tourOf if it tours one of them` });
  } else {
    const target = (shows || []).find(s => s.id === tour.tourOf);
    if (!target) out.push({ level: 'error', msg: `Tour "${tour.id}" tourOf "${tour.tourOf}" does not reference an existing show` });
    else if (isTourShow(target)) out.push({ level: 'error', msg: `Tour "${tour.id}" tourOf "${tour.tourOf}" is itself a tour; name the production it tours` });
  }
  return out;
}

/**
 * Show ids whose archived art a tour may use: itself, its tourOf, and any
 * same-title production in the parent's category or on Broadway.
 */
function allowedTourArtIds(tour, shows) {
  const t = normTitle(tour.title);
  const parent = tour.tourOf ? (shows || []).find(s => s.id === tour.tourOf) : null;
  const categories = new Set(['broadway']);
  if (parent && tourParentCategory(parent)) categories.add(tourParentCategory(parent));
  return [tour.id, ...(tour.tourOf ? [tour.tourOf] : []), ...(shows || [])
    .filter(s => !isTourShow(s) && categories.has(s.category || 'broadway') && normTitle(s.title) === t)
    .map(s => s.id)];
}

/**
 * Tour art must be the tour's own archived file, its parent's, or one from a
 * same-title production in the parent's category or on Broadway. Anything else
 * is a title-search accident (the Shucked tour once pointed at a SIX photo).
 * Returns problem strings.
 */
function tourImageProblems(tour, shows) {
  if (!isTourShow(tour) || !tour.images) return [];
  const allowed = allowedTourArtIds(tour, shows);
  const problems = [];
  for (const [k, v] of Object.entries(tour.images)) {
    if (!v || k.startsWith('_')) continue;
    const m = /^\/images\/shows\/([^/]+)\//.exec(String(v));
    if (!m) problems.push(`${k} is not an archived image (${String(v).slice(0, 80)})`);
    else if (!allowed.includes(m[1])) problems.push(`${k} comes from "${m[1]}", not this tour, its parent or a same-title "${tour.title}" production`);
  }
  return problems;
}

/**
 * Split targets for an aggregator that reviews New York productions only
 * (NYC Theatre, Playbill's Verdict). A national tour's title search there
 * finds its Broadway page, whose excerpts were filed as tour reviews
 * (BRO-4325). Returns { kept, tours }.
 */
function withoutTours(shows) {
  const kept = [];
  const tours = [];
  for (const s of shows || []) (isTourShow(s) ? tours : kept).push(s);
  return { kept, tours };
}

module.exports = {
  TOUR_PARENT_CATEGORIES,
  AUTO_TOUR_PARENT_CATEGORIES,
  TOUR_PARENT_LABELS,
  tourParentCategory,
  productionsOfTitle,
  normTitle,
  withoutTours,
  isTourShow,
  tourImageProblems,
  allowedTourArtIds,
  tourLinkProblems,
  MARKET_BEFORE_TOUR_RE,
  tourInheritance,
  applyTourInheritance,
  toursOfTitle,
  runningTourFor,
  tourWindows,
  pickTourForDate,
  BEFORE_LAUNCH_SLACK_DAYS,
  AFTER_CLOSE_SLACK_DAYS,
};
