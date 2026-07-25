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
 *   - one query per show, cooldown-gated (checkpoint-tracked) so it fires a
 *     handful of times across the window instead of every hourly cycle
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
  const tokens = String(venue || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !VENUE_STOPWORDS.has(w));
  return tokens.length ? tokens[0] : null;
}

/**
 * Build the full census query set for a show. The single "<title> review"
 * query fails exactly where the owner keeps catching us: weak-specificity
 * titles whose top-10 is polluted by the word's OTHER meaning ("Sukkot" the
 * holiday, "Shifters" the gearbox) — real reviews rank below the fold for
 * that one phrasing while a human's second, scoped query finds them
 * instantly (Sukkot 2026-07-25: Blogcritics + Theater Pizzazz invisible to
 * the census, page-1 on venue-scoped Google). So weak titles get up to two
 * extra scoped variants, the same follow-ups a human types:
 *   - venue-scoped:   "<title>" review 59e59
 *   - people-scoped:  "<title>" Leavitt review
 * Multi-word distinctive titles keep the single query (cost posture above).
 *
 * @param {object} show shows.json record ({title, category|market, openingDate, venue, creativeTeam?})
 * @param {object} [opts]
 * @param {boolean} [opts.weakTitle]  caller-computed: isGenericShowTitle(title) || titleTokens(title).length <= 1
 * @param {string[]} [opts.creativeNames] creative-team names (playwright/director first)
 * @returns {string[]} 1-3 queries, primary first; [] when the show has no title
 */
function buildCensusQueries(show, opts = {}) {
  const primary = buildCensusQuery(show);
  if (!primary) return [];
  const queries = [primary];
  if (!opts.weakTitle) return queries;

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
  marketTermFor,
  buildCensusQuery,
  buildCensusQueries,
  venueQueryToken,
  shouldRunSerpCensus,
};
