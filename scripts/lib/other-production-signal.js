'use strict';

/**
 * "Is this review about a DIFFERENT production than the show it is filed under?"
 *
 * BRO-4271 (School Girls 2026 opening night): the WestEndTheatre roundup
 * scraper matched the 2023 Lyric Hammersmith roundup to the 2026 Broadway show
 * (the London run is not in shows.json, so the Broadway row was the only
 * same-title candidate). Five 2023 London files landed, were correctly flagged
 * wrongProduction, and then SQUATTED their outlet slots: the stale-flag
 * collision guard refused the real 2026 Guardian review because an existing
 * guardian file carried a flag and the incoming roundup row had no date.
 *
 * A publish-date check alone is not enough. timeout-london--alice-saville.json
 * (a 2023 Time Out LONDON review) carried publishDate 2026-09-10: a
 * show-not-mentioned URL recovery once swapped its url to a Time Out NEW YORK
 * listing and took that page's date; the url was later reverted (BRO-4153)
 * but the date stayed. So this helper also reads signals that do not depend
 * on the stored date: the url's market edition, the outlet's home market, a
 * year baked into the url path, and a London venue named in the text.
 *
 * Pure apart from lazily loading outlet-registry.json (injectable for tests).
 * Returns the FIRST signal that fires, or null. Signals only ever say
 * "different production"; the absence of a signal proves nothing.
 */

const DAY_MS = 86400000;
// A review dated this far before the production's first preview is about an
// earlier production. Generous on purpose: pre-preview press is rare, and a
// false "other production" here costs a real review.
const PRE_PREVIEW_GRACE_DAYS = 60;
// Without a previewsStartDate, measure from opening with a wider margin.
const PRE_OPENING_GRACE_DAYS = 90;

const NYC_CATEGORIES = new Set(['broadway', 'off-broadway']);

let _regionMaps = null;
function loadRegionMaps() {
  if (_regionMaps) return _regionMaps;
  try {
    const reg = require('../../data/outlet-registry.json');
    const { buildOutletMaps } = require('./outlet-region-map');
    const m = buildOutletMaps(reg);
    _regionMaps = { outletRegionMap: m.outletRegionMap, dualMarket: m.dualMarket };
  } catch {
    _regionMaps = { outletRegionMap: {}, dualMarket: new Set() };
  }
  return _regionMaps;
}

function showMarket(show) {
  if (!show) return null;
  const { isLondonMarket } = require('./venue-classification');
  if (isLondonMarket(show.category)) return 'london';
  if (!show.category || NYC_CATEGORIES.has(show.category)) return 'nyc';
  return null; // tour / regional / other: no single home market
}

/** Market of a url on a declared path-split edition host (timeout.com). */
function urlEditionMarket(url) {
  const { resolveOutletFromUrlIfPathInformed } = require('./review-normalization');
  const resolved = resolveOutletFromUrlIfPathInformed(url);
  if (!resolved || !resolved.outletId) return null;
  if (resolved.outletId === 'timeout-london') return 'london';
  if (resolved.outletId === 'timeout') return 'nyc';
  return null;
}

/** A /YYYY/ path segment (Guardian /stage/2023/jun/18/, WordPress /2023/06/). */
function urlPathYear(url) {
  if (!url) return null;
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return null; }
  const m = pathname.match(/\/((?:19|20)\d{2})\//);
  return m ? parseInt(m[1], 10) : null;
}

function productionStart(show) {
  const prev = show && Date.parse(show.previewsStartDate || '');
  if (Number.isFinite(prev)) return { ms: prev, fromPreviews: true };
  const open = show && Date.parse(show.openingDate || '');
  if (Number.isFinite(open)) return { ms: open, fromPreviews: false };
  return null;
}

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[‘’]/g, "'");
}

/**
 * Text names a London venue and never names this show's own venue.
 * Only used for NYC shows: a Broadway review mentioning a London venue in
 * passing ("transfers from the Lyric Hammersmith") also names its Broadway
 * house, so requiring the absence of show.venue keeps that case out.
 */
function londonVenueInText(text, show) {
  if (!text || !show || !show.venue) return null;
  const t = normalizeText(text);
  const { normalizeVenueName } = require('./venue-classification');
  const own = normalizeVenueName(show.venue);
  if (own && t.includes(own)) return null;
  // Multi-word or distinctive London houses only: single common words from
  // the West End list ("arts", "apollo", "playhouse") appear in NYC prose.
  const LONDON_HOUSES = [
    'lyric hammersmith', 'national theatre', 'royal court', 'almeida', 'donmar warehouse',
    'young vic', 'old vic', 'bridge theatre', 'hampstead theatre', 'menier chocolate factory',
    'barbican', 'southwark playhouse', 'kiln theatre', 'orange tree theatre', 'theatre royal stratford east',
    'royal shakespeare company',
  ];
  const hit = LONDON_HOUSES.find((h) => t.includes(h));
  return hit || null;
}

/**
 * show.priorRuns declares earlier runs whose reviews COUNT for this show
 * (a Stratford East run transferring to the West End, a Met revival
 * inheriting its prior season). Dates, url years and markets covered by one
 * are not "another production".
 */
function priorRunCoversDate(show, dateStr) {
  if (!dateStr || !Array.isArray(show.priorRuns) || show.priorRuns.length === 0) return false;
  const { isWithinPriorRun } = require('./wrong-production-autoclear');
  return isWithinPriorRun(dateStr, show.priorRuns);
}

function priorRunCoversYear(show, year) {
  if (!year || !Array.isArray(show.priorRuns)) return false;
  return show.priorRuns.some((run) => {
    const a = Date.parse(run.openingDate || '');
    const b = Date.parse(run.closingDate || run.openingDate || '');
    if (!Number.isFinite(a)) return false;
    const y0 = new Date(a).getUTCFullYear();
    const y1 = Number.isFinite(b) ? new Date(b).getUTCFullYear() : y0;
    return year >= y0 && year <= y1 + 1; // +1: reviews of a run's tail land next January
  });
}

/** A prior run outside NYC: London outlets legitimately reviewed it. */
function hasNonNycPriorRun(show) {
  if (!Array.isArray(show.priorRuns) || show.priorRuns.length === 0) return false;
  const { isNonNycVenue } = require('./venue-classification');
  return show.priorRuns.some((run) => !run.venue || isNonNycVenue(run.venue));
}

/**
 * @param {object} review  - a review file or incoming review ({url, outletId, publishDate, fullText})
 * @param {object} show    - shows.json row ({category, venue, previewsStartDate, openingDate})
 * @param {object} [opts]
 * @param {boolean} [opts.skipDate]  - ignore publishDate (caller distrusts it)
 * @param {boolean} [opts.useText]   - also read fullText for a London venue.
 *   Off by default: a Broadway transfer's own review routinely names its
 *   London origin house. Only callers judging a file that is ALREADY flagged
 *   wrongProduction/wrongShow turn it on, as corroboration.
 * @param {object}  [opts.regionMaps] - {outletRegionMap, dualMarket} (tests)
 * @param {string[]} [opts.only]     - consider only these signal names
 * @returns {{ signal: string, detail: string } | null}
 */
function otherProductionSignal(review, show, opts = {}) {
  if (!review || !show) return null;
  const want = (name) => !opts.only || opts.only.includes(name);
  const market = showMarket(show);
  const url = review.url || null;

  const crossMarketPriorRun = hasNonNycPriorRun(show) || (market === 'london' && Array.isArray(show.priorRuns) && show.priorRuns.length > 0);

  // 1. url edition: timeout.com/london on a NYC show, /newyork on a London show.
  if (want('url-edition-market') && market && url && !crossMarketPriorRun) {
    const edition = urlEditionMarket(url);
    if (edition && edition !== market) {
      return { signal: 'url-edition-market', detail: `url is the ${edition} edition; show is ${market}` };
    }
  }

  // 2. outlet home market: a London-only (non-dual) outlet on a NYC show.
  // Dual-market outlets (Guardian, Times, The Stage...) review both cities and
  // are deliberately not judged here; signals 3-5 cover them.
  // Opera is exempt: London classical outlets (Bachtrack, The Arts Desk)
  // routinely review the Met and its cinema transmissions.
  if (want('outlet-market') && market === 'nyc' && review.outletId && !crossMarketPriorRun && show.type !== 'opera') {
    const { outletRegionMap, dualMarket } = opts.regionMaps || loadRegionMaps();
    const { UK_MARKET_REGIONS } = require('./cross-market-guard');
    const id = String(review.outletId).toLowerCase();
    if (UK_MARKET_REGIONS.has(outletRegionMap[id]) && !dualMarket.has(id)) {
      return { signal: 'outlet-market', detail: `outlet ${id} is London-only (region ${outletRegionMap[id]}); show is NYC` };
    }
  }

  const start = productionStart(show);
  if (start) {
    // 3. url year: a /2023/ path on a production whose previews began in 2026.
    const y = urlPathYear(url);
    const startYear = new Date(start.ms).getUTCFullYear();
    // The year the grace window opens: a December review of a show whose
    // previews start in January is not "another year's production".
    const graceDays = start.fromPreviews ? PRE_PREVIEW_GRACE_DAYS : PRE_OPENING_GRACE_DAYS;
    const limit = new Date(start.ms - graceDays * DAY_MS).getUTCFullYear();
    if (want('url-year') && y && y < limit && !priorRunCoversYear(show, y)) {
      return { signal: 'url-year', detail: `url path year ${y} predates production start ${startYear}` };
    }

    // 4. stored publishDate well before the production started.
    if (want('date-before-production') && !opts.skipDate && review.publishDate) {
      const pd = require('./date-utils').toDateMs(review.publishDate);
      const grace = (start.fromPreviews ? PRE_PREVIEW_GRACE_DAYS : PRE_OPENING_GRACE_DAYS) * DAY_MS;
      if (Number.isFinite(pd) && pd < start.ms - grace && !priorRunCoversDate(show, review.publishDate)) {
        const days = Math.round((start.ms - pd) / DAY_MS);
        return { signal: 'date-before-production', detail: `published ${review.publishDate}, ${days}d before ${start.fromPreviews ? 'first preview' : 'opening'}` };
      }
    }
  }

  // 5. text names a London house and not this show's own venue.
  if (want('venue-text') && opts.useText && market === 'nyc') {
    const venue = londonVenueInText(review.fullText, show);
    if (venue) return { signal: 'venue-text', detail: `text names "${venue}" and not ${show.venue}` };
  }

  return null;
}

/**
 * Shows a London-only aggregator (WestEndTheatre, Stagedoor, The Stage, LBO,
 * theatre.reviews) may be matched to: London-market rows only. Matching such
 * a roundup against every show lets a same-title Broadway row win whenever
 * the London production is not in shows.json (BRO-4271, School Girls 2026).
 */
function londonAggregatorCandidates(shows) {
  const { isLondonMarket } = require('./venue-classification');
  return (shows || []).filter((s) => s && isLondonMarket(s.category));
}

// Signals read from the url itself, never from a stored date that may be wrong
// or from an outlet that may legitimately cover both cities. Safe to act on at
// ingest, before anything is written (measured 2026-09-29 over 21,054
// included reviews: every remaining hit was a real other-production review).
const URL_SIGNALS = Object.freeze(['url-edition-market', 'url-year']);

/**
 * Audit the live corpus: included reviews (data/reviews.json) whose URL proves
 * another production. Exit 1 when any are found. Pure over its inputs.
 */
function auditIncludedReviews(reviews, shows) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const hits = [];
  for (const r of reviews) {
    const show = byId.get(r.showId);
    if (!show || !showMarket(show)) continue;
    const sig = otherProductionSignal(r, show, { only: URL_SIGNALS });
    if (sig) hits.push({ showId: r.showId, outletId: r.outletId, publishDate: r.publishDate || null, url: r.url, ...sig });
  }
  return hits;
}

if (require.main === module) {
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  const R = require(path.join(root, 'data', 'reviews.json'));
  const S = require(path.join(root, 'data', 'shows.json'));
  const hits = auditIncludedReviews(R.reviews || R, S.shows || S);
  for (const h of hits) console.log(`${h.signal} | ${h.showId} | ${h.outletId} | ${h.publishDate} | ${h.url}`);
  console.log(`other-production audit: ${hits.length} included review(s) whose url proves another production`);
  process.exit(hits.length ? 1 : 0);
}

module.exports = {
  londonAggregatorCandidates,
  auditIncludedReviews,
  otherProductionSignal,
  URL_SIGNALS,
  urlPathYear,
  urlEditionMarket,
  showMarket,
  PRE_PREVIEW_GRACE_DAYS,
  PRE_OPENING_GRACE_DAYS,
};
