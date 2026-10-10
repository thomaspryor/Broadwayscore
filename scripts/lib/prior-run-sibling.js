'use strict';
/**
 * prior-run-sibling — link a RETURNING production to the show entry that holds
 * its earlier run, and carry that run's reviews forward.
 *
 * Convention: one shows.json entry per run. A show that comes back (transfer,
 * remount, return engagement) gets a NEW entry and declares the earlier run on
 * `priorRuns` ({openingDate, closingDate, venue}). `priorRuns` is the operator
 * saying "same production" (wrong-production-autoclear.js, prior-run-republish-
 * guard.js: "a prior run there is the same production's own coverage").
 *
 * Two things went wrong when the earlier run ALSO has its own entry (found on
 * Kramer/Fauci, NYU Skirball Feb 2026 -> St. Ann's Oct 2026, BRO-4759):
 *
 *   1. The rebuild's director cross-check guard read the newer entry's director
 *      (Daniel Fish) as proof that any older-entry review naming him belongs to
 *      "a newer production" and excluded ALL FIVE February reviews, NYT among
 *      them, from the Skirball entry. The two entries are the same production,
 *      so the director is the same by definition. `isReturnOfProduction` is the
 *      exemption the guard now uses.
 *   2. Nothing ever moved the earlier entry's reviews onto the returning entry,
 *      so the returning show scored only on the few critics who re-reviewed.
 *      `inheritPriorRunReviews` does that, restricted to reviews dated inside
 *      the declared prior-run window.
 *
 * Pure: no I/O.
 */

const { toDateMs } = require('./date-utils');
const { findMatchingPriorRun } = require('./wrong-production-autoclear');

const DAY_MS = 86400000;
// Official opening vs. first preview vs. an aggregator's date for the same run
// routinely differ by a couple of weeks; a venue match inside this window is
// the same run.
const VENUE_MATCH_MAX_OPENING_GAP_DAYS = 45;

function ymd(value) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  return m ? m[1] : '';
}

/** Lowercase, fold "theatre/theater/the", drop punctuation: "The Public Theater" ~ "public". */
function canonVenue(venue) {
  return String(venue || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\btheatre\b|\btheater\b|\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Same normalization the rebuild's multi-production title groups use. */
function baseTitle(show) {
  return String((show && show.title) || '')
    .replace(/\s*\(.*?\)/g, '')
    .replace(/:\s.*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Does `newer` declare `older` (a separate show entry) as its prior run?
 *
 * 1. An explicit cross-link wins: a priorRuns entry carrying the older entry's id
 *    (`id`, `showId` or `productionId`, or a bare id string - the vocabulary
 *    deduplication.js isCrossLinked reads) IS the link, whatever the dates say.
 *    A run explicitly linked to a DIFFERENT entry is never heuristically matched.
 * 2. Otherwise a priorRuns entry with the same opening date as `older`, or the
 *    same venue with openings within VENUE_MATCH_MAX_OPENING_GAP_DAYS. This path
 *    also requires the same category (the rebuild never compares across markets)
 *    and a strictly earlier `older` opening.
 *
 * @returns {object|null} the matching priorRuns entry, or null
 */
function matchingPriorRunFor(newer, older) {
  if (!newer || !older || newer.id === older.id) return null;
  if (!Array.isArray(newer.priorRuns) || newer.priorRuns.length === 0) return null;

  for (const run of newer.priorRuns) {
    if (typeof run === 'string' && run === older.id) return { id: older.id };
    if (run && typeof run === 'object') {
      const linkId = run.id || run.showId || run.productionId;
      if (linkId === older.id) return run;
    }
  }

  if (newer.category !== older.category) return null;
  const olderOpen = ymd(older.openingDate);
  const newerOpen = ymd(newer.openingDate);
  if (olderOpen && newerOpen && olderOpen >= newerOpen) return null;

  const olderVenue = canonVenue(older.venue);
  for (const run of newer.priorRuns) {
    if (!run || typeof run !== 'object') continue;
    if (run.id || run.showId || run.productionId) continue; // explicitly linked to another entry
    const runOpen = ymd(run.openingDate);
    if (runOpen && olderOpen && runOpen === olderOpen) return run;
    if (!runOpen || !olderOpen || !olderVenue) continue;
    if (canonVenue(run.venue) !== olderVenue) continue;
    const gapDays = Math.abs(toDateMs(runOpen) - toDateMs(olderOpen)) / DAY_MS;
    if (gapDays <= VENUE_MATCH_MAX_OPENING_GAP_DAYS) return run;
  }
  return null;
}

function isReturnOfProduction(newer, older) {
  return matchingPriorRunFor(newer, older) !== null;
}

/**
 * Directors named on NEWER same-market productions of the same title, per older
 * production. Reviews in an older production's folder that mention such a
 * director are excluded as likely misfiled ("validated pattern" in the rebuild),
 * EXCEPT when the newer entry is a declared return of that older production:
 * same production, same director.
 *
 * @param {Array<object>} shows shows.json entries
 * @returns {Object<string, Map<string,string>>} olderShowId -> Map(directorLower -> newerShowId)
 */
function buildMultiProdDirectorGuard(shows) {
  const guard = {};
  const titleGroups = {};
  for (const s of shows) {
    const base = baseTitle(s);
    if (!titleGroups[base]) titleGroups[base] = [];
    titleGroups[base].push(s);
  }
  for (const prods of Object.values(titleGroups)) {
    if (prods.length < 2) continue;
    prods.sort((a, b) => {
      const da = a.openingDate ? new Date(a.openingDate).getTime() : Infinity;
      const db = b.openingDate ? new Date(b.openingDate).getTime() : Infinity;
      return da - db;
    });
    for (let i = 0; i < prods.length; i++) {
      const thisShow = prods[i];
      const thisDirectors = (thisShow.creativeTeam || [])
        .filter(ct => /director/i.test(ct.role))
        .map(ct => ct.name.toLowerCase());
      // Collect directors from NEWER productions in the SAME market only
      const newerDirs = new Map();
      for (let j = i + 1; j < prods.length; j++) {
        // Don't cross-compare different markets (Broadway vs West End vs Off-Broadway)
        if (prods[j].category !== thisShow.category) continue;
        // A declared return of THIS production is the same production, not a different one.
        if (isReturnOfProduction(prods[j], thisShow)) continue;
        for (const ct of (prods[j].creativeTeam || [])) {
          if (/director/i.test(ct.role)) {
            const name = ct.name.toLowerCase();
            // Skip if this person also directed the current production
            if (!thisDirectors.includes(name)) {
              newerDirs.set(name, prods[j].id);
            }
          }
        }
      }
      if (newerDirs.size > 0) guard[thisShow.id] = newerDirs;
    }
  }
  return guard;
}

function isExplicitLink(run, older) {
  if (typeof run === 'string') return run === older.id;
  return !!run && typeof run === 'object'
    && (run.id === older.id || run.showId === older.id || run.productionId === older.id);
}

/**
 * The window review dates are tested against: the declared run, or, for an
 * id-only link that carries no dates, the earlier entry's own run.
 */
function windowRunFor(run, sibling) {
  if (run && typeof run === 'object' && run.openingDate) return run;
  return { openingDate: ymd(sibling.openingDate), closingDate: ymd(sibling.closingDate) || undefined };
}

/**
 * Earlier-run entries a returning show declares via priorRuns. An explicit id
 * link holds whatever the titles say; a date/venue match also needs the same
 * base title.
 * @returns {Array<{sibling: object, run: object, window: object, explicit: boolean}>}
 */
function findPriorRunSiblings(show, shows) {
  if (!show || !Array.isArray(show.priorRuns) || show.priorRuns.length === 0) return [];
  const base = baseTitle(show);
  const out = [];
  for (const other of shows) {
    const run = matchingPriorRunFor(show, other);
    if (!run) continue;
    const explicit = isExplicitLink(run, other);
    if (!explicit && baseTitle(other) !== base) continue;
    out.push({
      sibling: other, run, window: windowRunFor(run, other), explicit,
      // `inheritReviews: false` on a priorRuns entry keeps the link (director-guard exemption,
      // dedup cross-link) but stops that run's reviews being carried onto this entry.
      carryReviews: !(run && typeof run === 'object' && run.inheritReviews === false),
    });
  }
  return out;
}

/**
 * Copies of the earlier entry's published reviews that belong on the returning
 * entry. A review is carried only when it is dated inside the declared prior-run
 * window (so a review of the earlier entry published long after it closed, or an
 * undated one, stays where it is) and the returning entry does not already have
 * it (same canonical URL, or same outlet + critic).
 *
 * Reviews already inherited (inheritedFromShowId) are never re-inherited, so a
 * re-run never duplicates and a chain does NOT propagate: only the entries a
 * show names directly on its own priorRuns contribute, so a third run must
 * declare EVERY earlier run, not just the latest.
 *
 * The window is the matched run's own (one sibling's window never admits a
 * review of another), or the earlier entry's dates for a dateless id link.
 *
 * A critic with no byline on one entry and a name on the other are different
 * (outlet, critic) pairs and both carry; the engine splits one outlet's vote
 * across its critics, so an outlet that reviewed both runs is not double-weighted.
 *
 * @param {Array<object>} reviews the rebuild's included reviews
 * @param {Array<object>} shows shows.json entries
 * @param {{canonicalizeUrl?: function(string): string}} [opts]
 * @returns {{inherited: Array<object>, links: Array<{newerId: string, olderId: string, count: number}>}}
 */
function inheritPriorRunReviews(reviews, shows, opts = {}) {
  const canonicalizeUrl = opts.canonicalizeUrl || (u => String(u || '').trim().toLowerCase());
  const byShow = new Map();
  for (const r of reviews) {
    if (!byShow.has(r.showId)) byShow.set(r.showId, []);
    byShow.get(r.showId).push(r);
  }
  const personKey = r => `${String(r.outletId || '').toLowerCase()}|${String(r.criticName || 'unknown').toLowerCase().replace(/\s+/g, '')}`;

  const inherited = [];
  const links = [];
  for (const show of shows) {
    for (const { sibling, window, carryReviews } of findPriorRunSiblings(show, shows)) {
      if (!carryReviews) continue;
      const existing = byShow.get(show.id) || [];
      const haveUrl = new Set(existing.map(r => canonicalizeUrl(r.url)).filter(Boolean));
      const havePerson = new Set(existing.map(personKey));
      let count = 0;
      for (const r of byShow.get(sibling.id) || []) {
        if (r.inheritedFromShowId) continue;
        if (!findMatchingPriorRun(r.publishDate, [window])) continue;
        const cu = canonicalizeUrl(r.url);
        if (cu && haveUrl.has(cu)) continue;
        if (havePerson.has(personKey(r))) continue;
        inherited.push({ ...r, showId: show.id, inheritedFromShowId: sibling.id });
        if (cu) haveUrl.add(cu);
        havePerson.add(personKey(r));
        count++;
      }
      if (count > 0) links.push({ newerId: show.id, olderId: sibling.id, count });
    }
  }
  return { inherited, links };
}

/**
 * Review-text files of the earlier-run entry that the rebuild carries onto
 * `show` (same window + includability rule as inheritPriorRunReviews), for
 * callers that work on review-text FOLDERS rather than reviews.json — the gap
 * audit decides "do we hold this aggregator-listed URL?" from the show's own
 * folder, so without this it keeps reporting the earlier run's reviews as
 * missing and re-ingests them every hour.
 *
 * Each returned file is a copy tagged `_ctxShow` (the entry whose folder holds
 * it — evaluate includability against THAT show), `_carriedFromShowId`, and
 * `_exactMatchOnly`: a carried file vouches for its own URL only. Letting it
 * stand in for "any covered file from this host" would let the February NYT
 * review hide a NEW nytimes.com review of the return (the BRO-4185 class).
 *
 * @param {object} show
 * @param {Array<object>} shows
 * @param {{loadFiles: function(string): Array<object>, isCovered: function(object, object): boolean}} deps
 */
function collectCarriedFiles(show, shows, deps) {
  const out = [];
  if (!Array.isArray(shows)) return out;
  for (const { sibling, window, carryReviews } of findPriorRunSiblings(show, shows)) {
    if (!carryReviews) continue;
    for (const d of deps.loadFiles(sibling.id) || []) {
      if (!findMatchingPriorRun(d.publishDate, [window])) continue;
      if (!deps.isCovered(d, sibling)) continue;
      out.push({ ...d, _ctxShow: sibling, _carriedFromShowId: sibling.id, _exactMatchOnly: true });
    }
  }
  return out;
}

/** Date windows of every earlier run `show` declares, including dateless id links resolved through the sibling entry. */
function priorRunWindows(show, shows) {
  const windows = Array.isArray(show && show.priorRuns) ? show.priorRuns.filter(r => r && r.openingDate) : [];
  for (const { window } of findPriorRunSiblings(show, shows || [])) {
    if (window && window.openingDate) windows.push(window);
  }
  return windows;
}

/** True when a review on a returning show covers an earlier run: carried from it, or dated inside one of its windows. */
function isPriorRunReview(review, windows) {
  if (review && review.inheritedFromShowId) return true;
  return !!findMatchingPriorRun(review && review.publishDate, windows);
}

/** Dated and outside every earlier-run window: a review of THIS run. Undated rows are neither. */
function isCurrentRunReview(review, windows) {
  return !!(review && review.publishDate) && !isPriorRunReview(review, windows);
}

/**
 * BRO-4954: one review per outlet on a returning production, newest wins. When an
 * outlet reviewed the return, its earlier-run reviews (carried, or filed on this
 * entry and dated inside a prior-run window) are superseded. Without this an outlet
 * that re-reviewed with a different critic counted twice: Into the Woods at the Noel
 * Coward showed 63 reviews, 12 of them second copies from outlets that also reviewed
 * the Bridge run. Shows without priorRuns are untouched.
 *
 * @param {Array<object>} reviews the rebuild's included reviews (inherited rows included)
 * @param {Array<object>} shows shows.json entries
 * @returns {Set<object>} the superseded review rows
 */
function supersededPriorRunReviews(reviews, shows) {
  const superseded = new Set();
  if (!Array.isArray(reviews) || !Array.isArray(shows)) return superseded;
  const showById = new Map(shows.map(s => [s.id, s]));
  const byShow = new Map();
  for (const r of reviews) {
    const show = showById.get(r.showId);
    if (!show || !Array.isArray(show.priorRuns) || show.priorRuns.length === 0) continue;
    if (!byShow.has(r.showId)) byShow.set(r.showId, []);
    byShow.get(r.showId).push(r);
  }
  const outletKey = r => String(r.outletId || r.outlet || '').trim().toLowerCase();
  for (const [showId, rows] of byShow) {
    const windows = priorRunWindows(showById.get(showId), shows);
    if (windows.length === 0) continue;
    const currentOutlets = new Set();
    for (const r of rows) {
      if (outletKey(r) && isCurrentRunReview(r, windows)) currentOutlets.add(outletKey(r));
    }
    for (const r of rows) {
      if (currentOutlets.has(outletKey(r)) && isPriorRunReview(r, windows)) superseded.add(r);
    }
  }
  return superseded;
}

module.exports = {
  priorRunWindows,
  isPriorRunReview,
  isCurrentRunReview,
  supersededPriorRunReviews,
  isReturnOfProduction,
  matchingPriorRunFor,
  buildMultiProdDirectorGuard,
  findPriorRunSiblings,
  inheritPriorRunReviews,
  collectCarriedFiles,
};
