/**
 * SERP review census — a general (market-agnostic) completeness reference for
 * the review-gap audit, sitting alongside the Playbill/BWW/WE-roundup sources
 * in scripts/lib/gap-reference-sources.js.
 *
 * Why this exists (Trainspotting WE, 2026-07-23): the gap audit's existing
 * references only see what aggregator editors chose to cite (Playbill
 * Verdict / BWW Review Roundup for Broadway; WET / theatre.reviews / LBO for
 * West End). A manual Google sweep ("I google it and find 20+" — owner)
 * surfaced soundspheremag.com and jonathanbaz.com reviews that NEITHER
 * aggregator cited — invisible to the gate by construction, because the gate
 * never asked Google the same question a human would. This module runs that
 * same "<title> review" SERP query, through the existing BD/SB/Scrapingdog
 * chain (scripts/lib/url-discovery.js), so long-tail/niche outlets the
 * aggregators skip still surface as a gap reference.
 *
 * Cost posture: SERP is not free (SB SERP ~25cr/call, BD ~$0.0015/call), and
 * this repo has hit SB monthly-cap exhaustion before (#224 — see also #201's
 * budget/kill-switch machinery in url-discovery.js, which this reuses via
 * serpQuery). So this source is deliberately narrow:
 *   - scoped to the opening window (inOpeningWindow), never the multi-year
 *     back-catalogue grind
 *   - 1-3 queries per show (see buildCensusQueries), cooldown-gated
 *     (checkpoint-tracked) so it fires a handful of times across the window
 *     instead of every hourly cycle
 *   - kill-switched via SERP_GAP_CENSUS_DISABLED=1
 *
 * Pure decision functions live here per CLAUDE.md §15 (test extraction); the
 * fetch + result-filtering glue lives in audit-show-review-gap.js's
 * auditShow(), which reuses that file's own isReviewUrl/urlMatchesShow/
 * normalizeReviewUrl filters (and url-discovery.js's generic-title
 * disambiguation guard) rather than duplicating them here.
 */

'use strict';

const { isLondonMarket } = require('./venue-classification');

const DEFAULT_COOLDOWN_HOURS = 6;

/** Market-appropriate search phrase, mirrors url-discovery.js's marketTerm. */
const { foldDiacritics } = require('./title-match');

function marketTermFor(show) {
  const cat = (show && (show.category || show.market)) || '';
  if (isLondonMarket(cat)) return 'West End review';
  if (cat === 'off-broadway') return 'Off-Broadway review';
  return 'Broadway review';
}

/**
 * Build the census SERP query for a show. Deliberately outlet-agnostic (no
 * site: filter) — the whole point is surfacing outlets we don't already know
 * about, the same way a human Googling "<title> review" would. Pure +
 * exported for unit testing.
 * @param {object} show shows.json record ({title, category|market, openingDate})
 * @returns {string|null} null when the show has no title to search on
 */
function buildCensusQuery(show) {
  if (!show || !show.title) return null;
  const title = String(show.title).replace(/\s*&\s*/g, ' and ');
  const year = (show.openingDate || '').slice(0, 4);
  const yearClause = year ? ` ${year}` : '';
  return `"${title}" ${marketTermFor(show)}${yearClause}`;
}

// Distinctive venue tokens (mirrors hasDisambiguator's filter in
// url-discovery.js): significant words only, generic venue vocabulary dropped
// so "…at the theatre" can't scope a query.
const VENUE_STOPWORDS = new Set([
  'theatre', 'theater', 'theaters', 'theatres', 'royal', 'open', 'house', 'main',
  'park', 'stage', 'stages', 'studio', 'arts', 'world', 'playhouse', 'center',
  'centre', 'hall', 'west', 'east', 'north', 'south', 'city', 'street',
]);
function venueQueryToken(venue) {
  const tokens = foldDiacritics(String(venue || '')).toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !VENUE_STOPWORDS.has(w));
  return tokens.length ? tokens[0] : null;
}

/**
 * Build the full census query set for a show. The single "<title> review"
 * query fails exactly where the owner keeps catching us: titles whose top-10
 * is polluted by the phrase's OTHER meaning ("Sukkot" the holiday, "Shifters"
 * the gearbox, two-word everyday phrases like "Loose Ends") — real reviews
 * rank below the fold for that one phrasing while a human's second, scoped
 * query finds them instantly (Sukkot 2026-07-25: Blogcritics + Theater
 * Pizzazz invisible to the census, page-1 on venue-scoped Google). Every show
 * gets the scoped variants its metadata supports, the same follow-ups a
 * human types:
 *   - venue-scoped:   "<title>" review 59e59
 *   - people-scoped:  "<title>" Leavitt review
 *
 * There is deliberately NO title-specificity trigger (the first cut gated on
 * single-token titles; second-opinion review 2026-07-26 removed it):
 * acceptSerpCensusResult filters results independently of which query found
 * them, so extra queries can only ADD accepted URLs, never contaminate —
 * meaning any "is this title ambiguous?" heuristic buys nothing but a few
 * cents of SERP spend (measured: ~+$0.10/day corpus-wide at BD rates) while
 * every title it misjudges is a missed-review class. Result-quality
 * escalation was rejected too: a query set derived from live results makes
 * serpCensus.complete non-deterministic and amplifies spend during provider
 * outages.
 *
 * @param {object} show shows.json record ({title, category|market, openingDate, venue, creativeTeam?})
 * @param {object} [opts]
 * @param {string[]} [opts.creativeNames] creative-team names (playwright/director first)
 * @returns {string[]} 1-3 queries, primary first; [] when the show has no title
 */
function buildCensusQueries(show, opts = {}) {
  const primary = buildCensusQuery(show);
  if (!primary) return [];
  const queries = [primary];

  const title = String(show.title).replace(/\s*&\s*/g, ' and ');
  const vt = venueQueryToken(show.venue || show.theater);
  if (vt) queries.push(`"${title}" review ${vt}`);

  const names = Array.isArray(opts.creativeNames) ? opts.creativeNames.filter(Boolean) : [];
  if (names.length) {
    const surname = String(names[0]).trim().split(/\s+/).pop();
    if (surname && surname.length > 3) queries.push(`"${title}" ${surname} review`);
  }
  return queries;
}

/**
 * The owner's own query, verbatim: no quotes, no year, no market term, just
 * "<title> <venue> review" — then READ PAST PAGE ONE.
 *
 * Why this is a separate arm (owner escalation 2026-08-02, task #872): every
 * query buildCensusQueries produces is phrase-quoted and year-clamped, which
 * is a precision instrument. A human Googling a new opening types the plain
 * words and scrolls. Measured on The Car Man (2026-08-02, Scrapingdog/gb):
 * the quoted census arms returned Sheffield-tour and Instagram chaff, while
 * `The Car Man review` page 2 held jadar.uk, cheekylittlematinee.com and
 * on-magazine.co.uk — three of the six reviews the owner found by hand and
 * the census reported as absent. Brainiac Live: thespyinthestalls (page 1) +
 * fairypoweredproductions (page 2). Tao of Glass: liamodell + timeout london
 * (page 2). Page 1 alone would have missed most of them: ticketing, venue and
 * social results crowd it out on a brand-new show.
 *
 * @param {object} show shows.json record ({title, venue|theater})
 * @returns {string|null}
 */
function buildNaiveCensusQuery(show) {
  if (!show || !show.title) return null;
  const title = String(show.title).replace(/\s*&\s*/g, ' and ');
  const venue = String(show.venue || show.theater || '').trim();
  return venue ? `${title} ${venue} review` : `${title} review`;
}

/**
 * Google country code for a show's census queries.
 *
 * url-discovery.js's _resolveGeo falls back to a substring test — `query
 * .includes('West End')` — so only the PRIMARY census arm (which happens to
 * contain the literal market term) searched google.co.uk. The venue-scoped,
 * creative-scoped and naive arms for a London show all searched US Google,
 * where UK theatre blogs rank far lower or not at all. Deriving geo from the
 * show's market instead of from the query text fixes that for every arm.
 */
function censusGeoFor(show) {
  const cat = (show && (show.category || show.market)) || '';
  return isLondonMarket(cat) ? 'gb' : 'us';
}

/** Default depth of the naive arm (pages 0,1,2 = Google results 1-30). */
const DEFAULT_NAIVE_PAGES = 3;

/**
 * Full census execution plan: every query the census should run for a show,
 * with the per-arm settings the caller must honor (date window on/off, result
 * page, geo). Pure + exported so the arm set is unit-testable without a live
 * SERP provider.
 *
 * The naive arm deliberately runs WITHOUT the date window. calculateDateWindow
 * becomes `after:/before:` operators on every provider, and Google can only
 * honor those for pages it has dated — undated blog posts (the exact long-tail
 * class this arm exists to catch) drop out of a date-restricted search.
 * Wrong-production noise is not the census's job to filter: acceptSerpCensusResult
 * plus the downstream production guards decide that, and the census is a
 * report-only completeness reference.
 *
 * @param {object} show
 * @param {object} [opts]
 * @param {string[]} [opts.creativeNames]
 * @param {number} [opts.naivePages] pages of the naive arm to read (default 3, 0 disables)
 * @returns {Array<{arm: string, query: string, useDateRange: boolean, page: number, geo: string}>}
 */
function buildCensusPlan(show, opts = {}) {
  const geo = censusGeoFor(show);
  const plan = buildCensusQueries(show, opts).map((query, i) => ({
    arm: i === 0 ? 'primary' : `scoped${i}`,
    query,
    useDateRange: true,
    page: 0,
    geo,
  }));
  if (!plan.length) return plan;

  const naivePages = Number.isInteger(opts.naivePages) ? opts.naivePages : DEFAULT_NAIVE_PAGES;
  const naive = buildNaiveCensusQuery(show);
  if (naive && naivePages > 0) {
    for (let page = 0; page < naivePages; page++) {
      plan.push({ arm: `naive-p${page}`, query: naive, useDateRange: false, page, geo });
    }
  }
  return plan;
}

/**
 * Did this census pass do enough to burn the cooldown?
 *
 * `complete` gates the checkpoint stamp: an incomplete pass must NOT sleep the
 * census for the cooldown window, or a flaky provider silently skips a show's
 * whole opening window (#444). But "every arm succeeded" stops being the right
 * rule once the plan has 6 arms instead of 1-3: the naive arm is the deepest
 * and flakiest, so one chronically-failing page-3 fetch would pin the stamp
 * off forever and re-fire the whole census every cycle for every in-window
 * show (ship-check 2026-08-02, #872). The floor is therefore: every scoped arm
 * succeeded, AND the naive arm returned at least one good page.
 *
 * @param {Array<{arm: string, ok: boolean}>} queryStatus per-arm outcomes
 * @returns {boolean}
 */
function isCensusPassComplete(queryStatus) {
  const arms = Array.isArray(queryStatus) ? queryStatus : [];
  if (arms.length === 0) return false;
  const isNaive = (a) => String(a && a.arm || '').startsWith('naive');
  const scoped = arms.filter(a => !isNaive(a));
  const naive = arms.filter(isNaive);
  if (!scoped.every(a => a.ok)) return false;
  return naive.length === 0 || naive.some(a => a.ok);
}

/**
 * Should the census run for this show right now? Pure gate combining the
 * opening-window scope with a per-show cooldown so the source fires a
 * handful of times across the window, not every hourly audit cycle.
 *
 * @param {object} params
 * @param {boolean} params.inWindow        - inOpeningWindow(show, now, windowDays) result (caller-computed)
 * @param {string|null} params.lastRunAt   - ISO timestamp of the last census run (checkpoint), or null if never run
 * @param {Date|number} [params.now]
 * @param {number} [params.cooldownHours]
 * @returns {boolean}
 */
function shouldRunSerpCensus({ inWindow, lastRunAt, now = Date.now(), cooldownHours = DEFAULT_COOLDOWN_HOURS }) {
  if (!inWindow) return false;
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return true; // corrupt stamp → treat as due, not stuck forever
  const nowMs = now instanceof Date ? now.getTime() : now;
  return (nowMs - last) >= cooldownHours * 3600000;
}

module.exports = {
  DEFAULT_COOLDOWN_HOURS,
  DEFAULT_NAIVE_PAGES,
  marketTermFor,
  buildCensusQuery,
  buildCensusQueries,
  buildNaiveCensusQuery,
  buildCensusPlan,
  censusGeoFor,
  isCensusPassComplete,
  venueQueryToken,
  shouldRunSerpCensus,
};
