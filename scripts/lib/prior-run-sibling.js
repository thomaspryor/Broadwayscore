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
// Owner rule 2026-10-11 (BRO-5000): once this many distinct outlets have reviewed the
// return itself, it has its own critic base and the earlier run's reviews stop being
// carried onto it. An explicit `inheritReviews: true` on the priorRuns entry overrides.
const RERUN_SEPARATE_MIN_OUTLETS = 5;

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
 * Directors of EARLIER, already-closed productions of the same title (BRO-5637).
 *
 * A revival's opening-night reviews routinely name the earlier staging's
 * director ("Joe Mantello's 2011 production"). When the CV verdict repeats
 * that name, review-guards' named-different-director bypass read it as proof
 * of a different staging and kept a genuine review excluded. This map lets
 * the bypass tell a historical reference from a different staging.
 *
 * Grouped by baseTitle across all categories (an Off-Broadway premiere is as
 * historical as an earlier Broadway run). Only productions whose closingDate
 * is strictly before this production's earliest date count, and a director
 * who also leads a same-title production that has NOT closed by then is
 * dropped: that staging could really be the review's subject. Unparseable
 * dates never qualify (fail closed).
 *
 * @param {Array<object>} shows shows.json entries
 * @param {(role: string) => boolean} isDirectorRole which creativeTeam roles
 *   count (review-guards passes its stage-director predicate)
 * @returns {Object<string, Map<string,string>>} showId -> Map(directorLower -> priorShowId)
 */
function buildPriorProductionDirectors(shows, isDirectorRole) {
  const { earliestShowDate } = require('./date-guard');
  const directorsOf = (s) => (s.creativeTeam || [])
    .filter(ct => ct && ct.name && isDirectorRole(String(ct.role || '')))
    .map(ct => ct.name.toLowerCase());
  const out = {};
  const titleGroups = {};
  for (const s of shows) {
    const base = baseTitle(s);
    if (!base) continue;
    (titleGroups[base] = titleGroups[base] || []).push(s);
  }
  for (const prods of Object.values(titleGroups)) {
    if (prods.length < 2) continue;
    for (const thisShow of prods) {
      const start = ymd(earliestShowDate(thisShow));
      if (!start) continue;
      const prior = new Map();
      const notClosed = new Set();
      for (const other of prods) {
        if (other === thisShow || other.id === thisShow.id) continue;
        const closed = ymd(other.closingDate);
        const isPrior = !!closed && closed < start;
        for (const name of directorsOf(other)) {
          if (!isPrior) notClosed.add(name);
          else if (!prior.has(name)) prior.set(name, other.id);
        }
      }
      for (const name of notClosed) prior.delete(name);
      if (prior.size > 0) out[thisShow.id] = prior;
    }
  }
  return out;
}

/**
 * Directors named on NEWER same-market productions of the same title, per older
 * production. Reviews in an older production's folder that mention such a
 * director are excluded as likely misfiled ("validated pattern" in the rebuild),
 * EXCEPT when the newer entry is a declared return of that older production:
 * same production, same director.
 *
 * Each director maps to the EARLIEST newer production that lists them, with
 * that production's start (previewsStartDate, else openingDate), so the guard
 * can tell a review published before that production began (BRO-5373).
 *
 * Productions are ordered by openingDate, then previewsStartDate, then
 * closingDate: an entry with no openingDate on file is not treated as the
 * newest (Dear England's 2023 Prince Edward transfer was, BRO-5373).
 *
 * @param {Array<object>} shows shows.json entries
 * @returns {Object<string, Map<string,{newerId:string, newerStart:(string|null)}>>}
 *   olderShowId -> Map(directorLower -> { newerId, newerStart })
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
    const orderKey = (s) => {
      const d = s.openingDate || s.previewsStartDate || s.closingDate;
      const ms = d ? new Date(d).getTime() : NaN;
      return Number.isNaN(ms) ? Infinity : ms;
    };
    prods.sort((a, b) => orderKey(a) - orderKey(b));
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
            if (!thisDirectors.includes(name) && !newerDirs.has(name)) {
              newerDirs.set(name, {
                newerId: prods[j].id,
                newerStart: ymd(prods[j].previewsStartDate) || ymd(prods[j].openingDate) || null,
              });
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
 * The priorRuns whose dates still exempt a review from the rebuild's
 * pre-opening (wrong-production) guard. A run marked `inheritReviews: false`
 * whose reviews have their own entry (a matched sibling) is dropped: a review
 * dated inside it belongs on that sibling, not here. Without a sibling the run
 * stays exempt, because this entry is then the only home those reviews have
 * (no such run in shows.json as of 2026-10-14: all five opted-out runs have
 * a sibling). BRO-5333:
 * the-comedy-about-spies-west-end-2026 kept re-collecting the 2025 run's
 * reviews unflagged and failing the class-A contamination gate.
 * @param {object} show shows.json entry
 * @param {Array<object>} shows all shows.json entries
 * @returns {Array<object>|undefined} show.priorRuns, minus opted-out runs with a sibling
 */
function preWindowExemptPriorRuns(show, shows) {
  if (!show || !Array.isArray(show.priorRuns)) return show ? show.priorRuns : undefined;
  const housed = new Set(findPriorRunSiblings(show, shows).filter(s => !s.carryReviews).map(s => s.run));
  return housed.size ? show.priorRuns.filter(r => !housed.has(r)) : show.priorRuns;
}

/** True when RERUN_SEPARATE_MIN_OUTLETS+ distinct outlets reviewed the return's own run. */
function reReviewedByManyOutlets(show, shows, existing) {
  const { isCurrent } = priorRunClassifier(show, shows);
  const outlets = new Set(existing.filter(isCurrent).map(r => String(r.outletId || '').toLowerCase()).filter(Boolean));
  return outlets.size >= RERUN_SEPARATE_MIN_OUTLETS;
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
    for (const { sibling, window, run, carryReviews } of findPriorRunSiblings(show, shows)) {
      if (!carryReviews) continue;
      const existing = byShow.get(show.id) || [];
      // A leased show's own folders are not rebuilt, so its rows arrive as opts.leasedReviews.
      // Counting them keeps the 5-outlet decision the same before and after the lease.
      const tally = (opts.leasedReviews || []).length ? existing.concat(opts.leasedReviews.filter(r => r.showId === show.id)) : existing;
      if (!(run && typeof run === 'object' && run.inheritReviews === true) && reReviewedByManyOutlets(show, shows, tally)) continue;
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
  for (const { sibling, window, run, carryReviews } of findPriorRunSiblings(show, shows)) {
    if (!carryReviews) continue;
    // Same 5-outlet separation the rebuild applies, so the gap audit agrees with what is published.
    if (!(run && typeof run === 'object' && run.inheritReviews === true) && reReviewedByManyOutlets(show, shows, deps.loadFiles(show.id) || [])) continue;
    for (const d of deps.loadFiles(sibling.id) || []) {
      if (!findMatchingPriorRun(d.publishDate, [window])) continue;
      if (!deps.isCovered(d, sibling)) continue;
      out.push({ ...d, _ctxShow: sibling, _carriedFromShowId: sibling.id, _exactMatchOnly: true });
    }
  }
  return out;
}

/**
 * Files an earlier-run sibling HOLDS but does not carry onto `show` (priorRuns
 * `inheritReviews: false`, or the 5-outlet separation): their reviews belong on
 * the sibling, so a gap audit must not list them as missing from `show`
 * (BRO-5705: Into the Woods Noel Coward listed 4 Bridge Theatre reviews the
 * Bridge entry already held). Same window + covered tests as collectCarriedFiles.
 * Report-only evidence; never feeds scoring.
 *
 * @returns {Array<object>} copies tagged `_housedOnShowId`
 */
function collectHousedSiblingFiles(show, shows, deps) {
  const out = [];
  if (!Array.isArray(shows)) return out;
  for (const { sibling, window, run, carryReviews } of findPriorRunSiblings(show, shows)) {
    const separated = carryReviews && !(run && typeof run === 'object' && run.inheritReviews === true)
      && reReviewedByManyOutlets(show, shows, deps.loadFiles(show.id) || []);
    if (carryReviews && !separated) continue;
    for (const d of deps.loadFiles(sibling.id) || []) {
      // An undated file the sibling holds still belongs to that run: it was filed there as
      // its review, and this list only suppresses a gap row (no scoring, no ingest).
      // Only from a sibling whose run closed before this one started, so a misfiled
      // current-run review cannot hide behind it.
      const siblingClosedFirst = toDateMs(sibling.closingDate) < runStartMs(show);
      if (d.publishDate ? !findMatchingPriorRun(d.publishDate, [window]) : !siblingClosedFirst) continue;
      if (!deps.isCovered(d, sibling)) continue;
      out.push({ ...d, _housedOnShowId: sibling.id });
    }
  }
  return out;
}

/**
 * Files a DIFFERENT, earlier-starting production of the same title in the same
 * market holds, dated inside that production's own run and before `show`'s first
 * preview/opening. No priorRuns link is needed: two unrelated productions can share
 * a title (BRO-5489: the Southwark Playhouse "Jane Eyre" musical, Aug-Oct 2026, and
 * the Rose Theatre Kingston "Jane Eyre" play, Oct 2026). The ingest refused the
 * Southwark-held URL as cross-show-url-owned and the opening-window alert kept
 * counting it as a gap the Kingston entry could never collect.
 * Dated files only (an undated one could be a misfiled review of this run), and a
 * review dated on or after this run's start never matches. Report-only evidence.
 *
 * @returns {Array<object>} copies tagged `_housedOnShowId`
 */
function collectSameTitleProductionFiles(show, shows, deps) {
  const out = [];
  if (!show || !Array.isArray(shows)) return out;
  const { getMarketPool } = require('./venue-classification');
  const start = runStartMs(show);
  if (!Number.isFinite(start)) return out;
  const base = baseTitle(show);
  const linked = new Set(findPriorRunSiblings(show, shows).map(s => s.sibling.id));
  for (const other of shows) {
    if (!other || other.id === show.id || linked.has(other.id) || !base || baseTitle(other) !== base) continue;
    if (getMarketPool(other.category) !== getMarketPool(show.category)) continue;
    const otherStart = runStartMs(other);
    if (!Number.isFinite(otherStart) || otherStart >= start) continue;
    const otherEnd = toDateMs(other.closingDate);
    for (const d of deps.loadFiles(other.id) || []) {
      const ms = toDateMs(d && d.publishDate);
      if (!Number.isFinite(ms) || ms < otherStart || ms >= start) continue;
      if (Number.isFinite(otherEnd) && ms > otherEnd) continue;
      if (!deps.isCovered(d, other)) continue;
      out.push({ ...d, _housedOnShowId: other.id });
    }
  }
  return out;
}

/**
 * True when a review URL's slug names an earlier run's venue ("...-at-bridge-theatre")
 * and not this run's own. A review of the return names the house it plays (BRO-5705:
 * westminsterextra's Bridge Theatre review listed against the Noel Coward transfer).
 * Slug only, never the host or query; the full venue phrase is required, so a bare
 * "bridge" in a title cannot match.
 */
function urlNamesPriorRunVenue(url, show) {
  if (!show || !Array.isArray(show.priorRuns) || !show.priorRuns.length) return false;
  let slug = '';
  const fold = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  try { slug = fold(decodeURIComponent(new URL(url).pathname)); } catch { return false; }
  // A transfer review names the old house too ("transfers-from-the-bridge-theatre").
  if (/\btransfer/.test(slug)) return false;
  const named = (venue) => {
    const v = fold(venue);
    const bare = v.replace(/\b(theatre|theater)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const has = (p) => p.split(' ').length >= 2 && ` ${slug} `.includes(` ${p} `);
    return has(v) || has(bare);
  };
  if (named(show.venue)) return false;
  return show.priorRuns.some(r => r && typeof r === 'object' && named(r.venue));
}

/**
 * True when a review URL's own /YYYY/MM/(DD/) path date falls inside an earlier run's
 * window and before this run's first preview/opening (BRO-5705: the SERP census kept
 * surfacing the Bridge run's March/April 2026 blog reviews for the Oct 2026 transfer).
 * Same URL-date evidence as isUrlYearOutOfWindow, one level finer, and only used to tag a
 * gap row prior-run (report-only). Undated URLs fail open (stay current).
 */
function urlDatedInPriorRun(url, show) {
  if (!show || !Array.isArray(show.priorRuns) || !show.priorRuns.length) return false;
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch { return false; }
  const m = /\/((?:19|20)\d{2})\/(0[1-9]|1[0-2])(?:\/(0[1-9]|[12]\d|3[01]))?(?:\/|$)/.exec(pathname);
  if (!m) return false;
  const date = `${m[1]}-${m[2]}-${m[3] || '15'}`;
  const ms = toDateMs(date);
  const start = runStartMs(show);
  if (!Number.isFinite(ms) || !Number.isFinite(start) || ms >= start) return false;
  return !!findMatchingPriorRun(date, show.priorRuns.filter(r => r && typeof r === 'object' && r.openingDate));
}

/** Date windows of every earlier run `show` declares, including dateless id links resolved through the sibling entry. */
function priorRunWindows(show, shows) {
  const windows = Array.isArray(show && show.priorRuns) ? show.priorRuns.filter(r => r && r.openingDate) : [];
  for (const { window } of findPriorRunSiblings(show, shows || [])) {
    if (window && window.openingDate) windows.push(window);
  }
  return windows;
}

/** Earliest of the show's first preview and opening, as ms (NaN when neither is set). */
function runStartMs(show) {
  const starts = [show && show.previewsStartDate, show && show.openingDate]
    .map(toDateMs).filter(Number.isFinite);
  return starts.length ? Math.min(...starts) : NaN;
}

/**
 * Sorts a returning show's reviews into earlier-run and this-run. A review dated
 * on or after this run's first preview/opening is this run's, whatever the prior
 * window's 7-day review-lag grace says: a tour that closes the day before the
 * West End previews would otherwise claim the opening-night reviews (The Car Man,
 * Allegra). A dated review that is neither in a prior window nor after this run
 * started (an announcement-era piece) is neither, like an undated one.
 *
 * @returns {{windows: Array<object>, isPrior: function(object): boolean, isCurrent: function(object): boolean}}
 */
function priorRunClassifier(show, shows) {
  const windows = priorRunWindows(show, shows);
  const startMs = runStartMs(show);
  const afterStart = ms => Number.isFinite(startMs) && ms >= startMs;
  const isPrior = (review) => {
    if (!review) return false;
    if (review.inheritedFromShowId) return true;
    const ms = toDateMs(review.publishDate);
    if (!Number.isFinite(ms) || afterStart(ms)) return false;
    return !!findMatchingPriorRun(review.publishDate, windows);
  };
  const isCurrent = (review) => {
    if (!review || review.inheritedFromShowId) return false;
    const ms = toDateMs(review.publishDate);
    if (!Number.isFinite(ms)) return false;
    if (Number.isFinite(startMs)) return ms >= startMs;
    return !findMatchingPriorRun(review.publishDate, windows);
  };
  return { windows, isPrior, isCurrent };
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
    const { windows, isPrior, isCurrent } = priorRunClassifier(showById.get(showId), shows);
    if (windows.length === 0) continue;
    const currentOutlets = new Set();
    for (const r of rows) {
      if (outletKey(r) && isCurrent(r)) currentOutlets.add(outletKey(r));
    }
    for (const r of rows) {
      if (currentOutlets.has(outletKey(r)) && isPrior(r)) superseded.add(r);
    }
  }
  return superseded;
}

module.exports = {
  priorRunWindows,
  priorRunClassifier,
  supersededPriorRunReviews,
  isReturnOfProduction,
  matchingPriorRunFor,
  baseTitle,
  buildMultiProdDirectorGuard,
  buildPriorProductionDirectors,
  findPriorRunSiblings,
  preWindowExemptPriorRuns,
  inheritPriorRunReviews,
  reReviewedByManyOutlets,
  RERUN_SEPARATE_MIN_OUTLETS,
  collectCarriedFiles,
  collectHousedSiblingFiles,
  collectSameTitleProductionFiles,
  urlNamesPriorRunVenue,
  urlDatedInPriorRun,
};
