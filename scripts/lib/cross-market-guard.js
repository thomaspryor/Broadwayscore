'use strict';

/**
 * Reverse cross-market classification.
 *
 * A "reverse cross-market" review is a non-West-End (NYC: Broadway / off-Broadway)
 * review that carries a London-region outlet. This decides how loudly
 * validate-data.js should complain about it.
 *
 * Levels:
 *   'skip'     — an isDualMarket outlet (legit by definition) or a non-London
 *                outlet. Nothing to flag.
 *   'advisory' — Tier 3 / untiered London outlet on a *Broadway* show. This is the
 *                plays-to-see / The Arts Desk class: niche London aggregators that
 *                legitimately cover Broadway transfers and slowly accumulate NYC
 *                reviews. We surface them as isDualMarket candidates but do NOT
 *                block the build — that's the whole point of this guard. Before
 *                2026-06-15 these hit the hard error below and turned CI red
 *                (plays-to-see: oslo-2017, the-father-2016, long-days-journey-2016),
 *                forcing a reactive isDualMarket fix after the build was already
 *                broken. See memory/feedback_plays_to_see_dual_market.md.
 *   'warning'  — London outlet on an off-Broadway/other NYC show (Met opera cinema
 *                transmissions, London-to-NYC transfers, festival co-productions).
 *                Already-tolerated coverage; advisory by long-standing convention.
 *   'error'    — Tier 1/2 London *prestige* paper (Evening Standard, Times UK, etc.)
 *                on a mainstage *Broadway* show. These never legitimately cover
 *                Broadway, so a non-dualMarket Tier 1/2 hit is a genuine
 *                contamination signal worth blocking the build over.
 *
 * Pure function — no I/O, no globals. validate-data.js feeds it the flags it
 * already computes (outletRegionMap / dualMarket / tier12Outlets / category).
 *
 * @param {object} args
 * @param {string|null|undefined} args.region    - outlet region ('london' | other)
 * @param {boolean} args.isDualMarket            - outlet has isDualMarket:true
 * @param {boolean} args.isTier12                - outlet is Tier 1 or Tier 2
 * @param {boolean} args.isBroadway             - the reviewed show is Broadway category
 * @returns {{ level: 'skip'|'advisory'|'warning'|'error', reason: string }}
 */
function classifyReverseCrossMarket({ region, isDualMarket, isTier12, isBroadway }) {
  if (isDualMarket) {
    return { level: 'skip', reason: 'dual-market outlet (legit by definition)' };
  }
  if (region !== 'london') {
    return { level: 'skip', reason: 'not a London outlet' };
  }
  if (!isBroadway) {
    return {
      level: 'warning',
      reason: 'London outlet on off-Broadway/other NYC show (opera transmissions, transfers)',
    };
  }
  if (isTier12) {
    return {
      level: 'error',
      reason: 'Tier 1/2 London prestige outlet on Broadway — never legitimately covers it',
    };
  }
  return {
    level: 'advisory',
    reason: 'Tier 3/untiered London outlet accumulating Broadway reviews — isDualMarket candidate',
  };
}

/**
 * Same-title cross-market contamination classifier (date-cluster + corroboration).
 *
 * A review filed under show X can actually be reviewing a same-title sibling
 * production Y in a different market (West End ⟷ NYC). The pre-existing Category-A
 * detector in audit-review-contamination.js only caught these when the review was
 * >180 days from X's opening — so same-SEASON siblings (e.g. West End R&J opened
 * 2026-03-31 vs Delacorte R&J opened 2026-06-11, ~72d apart) slipped through and
 * inflated the wrong show's score (user report #382, 2026-06-26).
 *
 * This adds a RELATIVE date-cluster test: the review clusters tightly with a
 * sibling's opening AND is materially farther from this show's opening. To avoid
 * false-positives on legitimate dual-market coverage (Guardian/Times-UK/Telegraph
 * review the Broadway opening on its actual date), a date cluster ALONE is never
 * enough to flag — it must be CORROBORATED by either:
 *   • region mismatch  — outlet's region belongs to the sibling's market, not this
 *                        show's (London outlet on a US show whose sibling is WE), or
 *   • url-token match  — the review URL contains the sibling's cast/venue tokens.
 * An uncorroborated date cluster returns level 'review' (surface for a human),
 * never 'contamination'. The legacy >180d path is preserved as 'contamination'
 * with no corroboration required (unchanged behavior).
 *
 * Pure function — caller supplies parsed dates, markets, region and the url-token
 * boolean (the audit computes those from shows.json + the registry maps).
 *
 * @param {object} a
 * @param {Date}   a.reviewDate            - review publishDate (parsed)
 * @param {string|null} a.reviewUrl        - review URL (checked against the best sibling's tokens)
 * @param {{opening: Date|null, market: 'us'|'uk'}} a.thisShow
 * @param {Array<{id:string, opening: Date, market:'us'|'uk', tokens?: string[]}>} a.siblings - same-title other productions; tokens = cast/venue slugs
 * @param {string|null} a.outletRegion     - outlet region ('london'|'us'|'new-york'|'dual'|null)
 * @param {boolean} a.isDualMarket         - outlet flagged isDualMarket
 * @param {number} [a.margin=45]           - min extra days the review must be farther from this show than the sibling
 * @returns {{ level: 'contamination'|'review'|'clear', confidence: 'high'|null, reason: string, sibId: string|null, thisDiff: number|null, sibDiff: number|null }}
 */
// A slug token matches a URL only when delimited by non-alphanumerics or string
// ends — so 'sink' matches '…-sadie-sink-review…' but NOT 'sinking', and 'globe'
// does not match 'theglobeandmail'. Tokens are already lowercase slugs.
function tokenInUrl(token, url) {
  const i = url.indexOf(token);
  if (i < 0) return false;
  const before = i === 0 ? '' : url[i - 1];
  const after = i + token.length >= url.length ? '' : url[i + token.length];
  const boundary = (ch) => ch === '' || !/[a-z0-9]/.test(ch);
  return boundary(before) && boundary(after);
}

function classifyCrossMarketContamination({
  reviewDate, reviewUrl, thisShow, siblings, outletRegion, isDualMarket, margin = 45,
}) {
  const clear = { level: 'clear', confidence: null, reason: '', sibId: null, thisDiff: null, sibDiff: null };
  if (!reviewDate || !thisShow || !thisShow.opening || !Array.isArray(siblings) || !siblings.length) return clear;

  const DAY = 86400000;
  const thisDiff = Math.abs(reviewDate - thisShow.opening) / DAY;
  let best = null;
  for (const s of siblings) {
    if (!s.opening) continue;
    const diff = Math.abs(reviewDate - s.opening) / DAY;
    if (!best || diff < best.diff) best = { ...s, diff };
  }
  if (!best) return clear;
  const out = { sibId: best.id, thisDiff: Math.round(thisDiff), sibDiff: Math.round(best.diff) };

  // URL corroboration: does the review URL contain a distinctive cast/venue token of
  // the best (date-closest) sibling? Tokens are precomputed by the caller from shows.json.
  // Match on SLUG BOUNDARIES (token delimited by non-alphanumeric or string ends), not raw
  // substring — otherwise 'hall' matches 'marshall', 'globe' matches 'theglobeandmail', etc.
  const url = (reviewUrl || '').toLowerCase();
  const urlMatchesSibling = !!(url && Array.isArray(best.tokens) && best.tokens.some(t => t && tokenInUrl(t, url)));

  // Legacy always-on path: tight sibling cluster AND very far from this show.
  // Preserved unchanged (no corroboration required) so existing strict behavior holds.
  if (best.diff <= 30 && thisDiff > 180) {
    return { ...out, level: 'contamination', confidence: 'high', reason: `clusters with sibling ${best.id} (${out.sibDiff}d) and is ${out.thisDiff}d from this show (>180d)` };
  }

  // Relative same-season path: clusters with a sibling AND materially farther from this show.
  const dateCluster = best.diff <= 30 && thisDiff >= best.diff + margin;
  if (!dateCluster) return { ...clear, ...out };

  // Corroboration — required before we flag (avoids FP on legit dual-market coverage).
  // Region mismatch only corroborates for NON-dual-market outlets: a dual-market
  // outlet (Times UK/Telegraph/Guardian) legitimately covers both markets, so its
  // region tells us nothing about which production it reviewed — those need the
  // url-token signal instead.
  const regionMismatch = !isDualMarket && (
    (outletRegion === 'london' && thisShow.market === 'us' && best.market === 'uk') ||
    (outletRegion && outletRegion !== 'london' && outletRegion !== 'dual' && thisShow.market === 'uk' && best.market === 'us')
  );

  if (regionMismatch || urlMatchesSibling) {
    const why = regionMismatch
      ? `outlet region '${outletRegion}' matches sibling market '${best.market}', not this show '${thisShow.market}'`
      : `url contains sibling ${best.id} cast/venue token`;
    return { ...out, level: 'contamination', confidence: 'high', reason: `clusters with sibling ${best.id} (${out.sibDiff}d, this ${out.thisDiff}d); ${why}` };
  }

  // Date cluster but no corroboration → surface for a human, never auto-flag.
  return { ...out, level: 'review', confidence: null, reason: `date-clusters with sibling ${best.id} (${out.sibDiff}d, this ${out.thisDiff}d) but no region/url corroboration${isDualMarket ? ' (dual-market outlet)' : ''}` };
}

/**
 * Forward cross-market classification: a US-region outlet review on a
 * West End / off-West End show — the reverse of classifyReverseCrossMarket.
 *
 * History (card 386637c5): validate-data.js only WARNED on US-outlet-on-WE, so
 * Broadway reviews leaking onto WE revivals (Glengarry WE 2026 carrying the
 * Culkin/Odenkirk Broadway-2025 EW/NYDailyNews/Yahoo reviews) never failed CI.
 * A domain-only error tier was rejected in 2026-06-21's pass — NYT/Variety
 * legitimately review the West End near opening — so the error tier requires
 * BOTH signals: an explicitly US-region outlet AND a pre-window publish date
 * (>PRE_WINDOW_DAYS before the show's earliest date, outside any priorRun —
 * the caller computes that via evaluatePreWindowInclusion).
 *
 * Levels:
 *   'skip'    — dual-market outlet, Tier 1/2 outlet (prestige papers cover both
 *               markets), or a UK-side region ('london'/'uk'/'dual').
 *   'error'   — explicitly US-region outlet AND pre-window date. Both signals
 *               present = genuine cross-production contamination; block the build.
 *   'warning' — any other non-London outlet on a WE show (unknown region, or
 *               US region with an in-window date — legitimate transfer coverage
 *               and dual-market candidates surface here without blocking).
 *
 * Pure function — validate-data.js feeds it flags it already computes.
 *
 * @param {object} args
 * @param {string|null|undefined} args.region - outlet region from the registry
 * @param {boolean} args.isDualMarket
 * @param {boolean} args.isTier12
 * @param {boolean} args.isPreWindowDate - review publishDate falls before the
 *   show's pre-window threshold and outside every declared priorRun
 * @returns {{ level: 'skip'|'error'|'warning', reason: string }}
 */
function classifyUsOnWeCrossMarket({ region, isDualMarket, isTier12, isPreWindowDate }) {
  if (isDualMarket) {
    return { level: 'skip', reason: 'dual-market outlet (legit by definition)' };
  }
  if (isTier12) {
    return { level: 'skip', reason: 'Tier 1/2 outlet — prestige papers legitimately review the West End' };
  }
  if (region === 'london' || region === 'uk' || region === 'dual') {
    return { level: 'skip', reason: 'UK-side outlet' };
  }
  // Registry regions other than london/uk/dual are all US-side ('us' or a US
  // city). An absent region means the outlet is unknown to the registry — not
  // enough signal to block a build on.
  if (region && isPreWindowDate) {
    return {
      level: 'error',
      reason: `US-region outlet ('${region}') with pre-window publish date on West End show — cross-production contamination`,
    };
  }
  return { level: 'warning', reason: 'non-London outlet on West End show' };
}

/**
 * Forward cross-market GUARD: decides whether a review filed under a West
 * End / Off-West-End show is actually a Broadway leak — a US-market outlet
 * with no legitimate reason to be reviewing a London production. This is
 * the rebuild-all-reviews.js flagging decision (sets wrongProduction on the
 * review file), distinct from classifyUsOnWeCrossMarket() above (a CI
 * validate-data.js severity classifier that only warns/errors, never writes).
 *
 * Extracted from rebuild-all-reviews.js (BRO-254) so the outlet-region
 * lookup can be unit tested directly against the real outlet-registry.json,
 * instead of only being exercisable by running the full rebuild.
 */

/**
 * outletId -> region (e.g. 'london'), built from the outlet registry.
 * Registered ids AND their (lowercased) aliases map to the same region.
 *
 * Delegates to lib/outlet-region-map.js's buildOutletMaps() — the
 * pre-existing single source of truth shared by validate-data.js and
 * audit-review-contamination.js — instead of re-deriving this map, so this
 * guard can't drift from that implementation (it previously did: this
 * function used to build its own copy that didn't lowercase alias keys,
 * the exact bug a 2026-06-15 ship-check already had to fix once upstream).
 */
function buildOutletRegionMap(outletRegistry) {
  return require('./outlet-region-map').buildOutletMaps(outletRegistry).outletRegionMap;
}

/**
 * Lowercased set of every registered outlet id + alias. Lets the guard
 * distinguish "registered but region-less" (US nationals; keep flagging)
 * from "not in the registry at all" (brand-new outlet; bootstrap
 * exemption, task #817).
 */
function buildRegisteredOutletIds(outletRegistry) {
  const registeredOutletIds = new Set();
  for (const [id, info] of Object.entries(outletRegistry.outlets)) {
    registeredOutletIds.add(id.toLowerCase());
    if (info.aliases) for (const a of info.aliases) registeredOutletIds.add(String(a).toLowerCase());
  }
  return registeredOutletIds;
}

/**
 * URL-domain fallback: used when an outlet has no region in the registry,
 * so unknown UK outlets (blogs, small reviewers) aren't flagged as US.
 */
function isUkUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname || '';
    return hostname.endsWith('.co.uk') || hostname.endsWith('.org.uk')
      || hostname.includes('london') || (hostname.includes('theatre') && !hostname.includes('newyork'));
  } catch (e) {
    return false;
  }
}

/**
 * @param {object} params
 * @param {object} params.outletRegionMap - from buildOutletRegionMap()
 * @param {Set<string>} params.registeredOutletIds - from buildRegisteredOutletIds()
 * @param {string} params.canonicalOutlet - normalizeOutletCanonical(rawOutlet)
 * @param {string} params.rawOutlet - lowercased data.outletId || data.outlet
 * @param {string} params.url - data.url
 * @param {object} [params.contentVerification] - data.contentVerification
 * @param {Date|string|null} [params.reviewDate] - parsed/parseable review publish date
 * @param {Array|null|undefined} [params.priorRuns] - show.priorRuns
 * @returns {{ shouldFlag: boolean, reason: string|null, exemptedByPriorRun: boolean }}
 */
function evaluateForwardCrossMarketGuard({
  outletRegionMap,
  registeredOutletIds,
  canonicalOutlet,
  rawOutlet,
  url,
  contentVerification,
  reviewDate,
  priorRuns,
}) {
  const outletRegion = outletRegionMap[canonicalOutlet] || outletRegionMap[rawOutlet];
  if (outletRegion === 'london') return { shouldFlag: false, reason: null, exemptedByPriorRun: false };
  if (isUkUrl(url)) return { shouldFlag: false, reason: null, exemptedByPriorRun: false };

  // Production-continuity exemption (BRO-222 cousin, opposite direction): a
  // review whose publishDate falls inside a declared priorRuns window is
  // coverage of THAT run, not the current (West End) one — its market must be
  // judged against the prior run's own venue, not the current show's market.
  // E.g. a US critic's in-window coverage of a declared Off-Broadway/regional
  // run before a West End transfer. Same structural gap as the reverse guard
  // (evaluateReverseLondonCrossMarketGuard, BRO-222) — this guard consulted
  // show.priorRuns nowhere at all before this fix.
  const { findMatchingPriorRun } = require('./wrong-production-autoclear');
  const matchedPriorRun = findMatchingPriorRun(reviewDate, priorRuns);
  if (matchedPriorRun && isUsVenueString(matchedPriorRun.venue)) {
    return { shouldFlag: false, reason: null, exemptedByPriorRun: true };
  }

  // Don't flag when contentVerification has already affirmatively verified
  // the production is correct with high confidence. [GUARD:CROSS-MARKET-CV-OVERRIDE]
  const cv = contentVerification;
  const cvSaysCorrect = cv && cv.isValid === true
    && cv.wrongProduction === false && cv.confidence === 'high';

  // Bootstrap exemption for COMPLETELY unregistered outlets (task #817).
  const outletIsUnregistered = !registeredOutletIds.has(canonicalOutlet)
    && !registeredOutletIds.has(rawOutlet);

  if (cvSaysCorrect || outletIsUnregistered) {
    return { shouldFlag: false, reason: null, exemptedByPriorRun: false };
  }

  return { shouldFlag: true, reason: `Cross-market: US outlet "${rawOutlet}" reviewing London show`, exemptedByPriorRun: false };
}

/**
 * UK-market signal in a free-text venue string (show.priorRuns[].venue).
 *
 * priorRuns entries carry a human-written venue string (e.g. "Edinburgh
 * Festival Fringe (Assembly)"), not a structured market/region field —
 * this is a lightweight keyword classifier over that string, matching the
 * same "does the text say UK" approach the codebase already uses for URL
 * hostnames (isUkUrl above) and festival-venue detection
 * (review-guards.js's FESTIVAL_VENUE_SHOW_RE).
 *
 * Deliberately excludes bare "fringe" and "england" — both collide with
 * genuine US venue text (FringeNYC / New York International Fringe
 * Festival; "New England ..." theaters/venue names) and a false match here
 * wrongly EXEMPTS a cross-market review from a real contamination flag,
 * which is a worse failure than under-matching (ship-check finding,
 * BRO-222). "edinburgh" alone already covers the Edinburgh Fringe case this
 * guard exists for.
 *
 * @param {string|null|undefined} venue
 * @returns {boolean}
 */
const UK_VENUE_RE = /\b(?:london|west end|off[- ]?west end|edinburgh|glasgow|manchester|birmingham|leeds|liverpool|bristol|cardiff|scotland|wales|u\.?k\.?|united kingdom)\b/i;

function isUkVenueString(venue) {
  return !!(venue && UK_VENUE_RE.test(String(venue)));
}

/**
 * US-market signal in a free-text venue string (show.priorRuns[].venue),
 * used by the forward guard's own priorRuns exemption (BRO-222 cousin,
 * opposite direction).
 *
 * Deliberately a POSITIVE keyword match (same shape as isUkVenueString),
 * NOT "not UK" — an earlier version defined this as `!isUkVenueString(venue)`
 * and ship-check adversarial review caught the resulting failure-open hole:
 * plenty of genuine UK regional venues (Chichester Festival Theatre, Sheffield
 * Crucible, Bath Theatre Royal, Nottingham Playhouse, York Theatre Royal,
 * Newcastle Theatre Royal, Belfast Grand Opera House, ...) carry no keyword
 * from UK_VENUE_RE's necessarily-partial city list, so "not UK" silently
 * became "US" and would wrongly EXEMPT a real cross-market Broadway leak
 * whose declared priorRun was actually a UK regional tryout before the West
 * End transfer — worse than under-matching, same principle isUkVenueString's
 * own docstring states. Requiring an explicit US signal instead means an
 * unrecognized venue string fails CLOSED (guard still flags), not open.
 *
 * @param {string|null|undefined} venue
 * @returns {boolean}
 */
const US_VENUE_RE = /\b(?:off[- ]?broadway|off[- ]?off[- ]?broadway|broadway|new york|nyc|brooklyn|manhattan|chicago|los angeles|san francisco|berkeley|boston|philadelphia|washington(?:,?\s*d\.?c\.?)?|atlanta|seattle|denver|minneapolis|dallas|houston|connecticut|massachusetts|california|u\.?s\.?a?\.?|united states)\b/i;

function isUsVenueString(venue) {
  return !!(venue && US_VENUE_RE.test(String(venue)));
}

/**
 * Reverse cross-market guard (London outlet reviewing a Broadway/off-Broadway
 * show), priorRuns-aware.
 *
 * Background (BRO-222): a review whose publishDate falls inside a show's
 * declared priorRuns window is coverage of THAT run, not the current one —
 * its market must be judged against the prior run's own venue, not the
 * current show's market. Before this fix, the rebuild's reverse cross-market
 * block (rebuild-all-reviews.js "GUARD:CROSS-MARKET-LONDON-ON-OTHER")
 * consulted show.priorRuns nowhere at all, so a UK critic's in-window
 * coverage of a declared Edinburgh Fringe run got excluded from a live NYC
 * transfer show as "Cross-market: London outlet reviewing off-broadway show"
 * (rosie-odonnell-common-knowledge-off-broadway-2026 /
 * neurodiversereview--simon-jay.json, live newsletter incident).
 *
 * Pure — the caller resolves reviewDate/priorRuns and the raw "is this a
 * London outlet" signal (outletRegion === 'london' or a UK-hosted URL); this
 * function only decides whether a declared prior run exempts the review.
 *
 * @param {object} args
 * @param {boolean} args.outletIsLondon - outletRegion === 'london', or the review URL is UK-hosted
 * @param {Date|string|null} args.reviewDate - parsed/parseable review publish date
 * @param {Array|null|undefined} args.priorRuns - show.priorRuns
 * @returns {{ shouldFlag: boolean, exemptedByPriorRun: boolean, matchedVenue: string|null }}
 */
function evaluateReverseLondonCrossMarketGuard({ outletIsLondon, reviewDate, priorRuns }) {
  if (!outletIsLondon) return { shouldFlag: false, exemptedByPriorRun: false, matchedVenue: null };
  const { findMatchingPriorRun } = require('./wrong-production-autoclear');
  const match = findMatchingPriorRun(reviewDate, priorRuns);
  if (match && isUkVenueString(match.venue)) {
    return { shouldFlag: false, exemptedByPriorRun: true, matchedVenue: match.venue };
  }
  return { shouldFlag: true, exemptedByPriorRun: false, matchedVenue: null };
}

module.exports = {
  classifyReverseCrossMarket,
  classifyCrossMarketContamination,
  classifyUsOnWeCrossMarket,
  buildOutletRegionMap,
  buildRegisteredOutletIds,
  isUkUrl,
  isUkVenueString,
  isUsVenueString,
  evaluateForwardCrossMarketGuard,
  evaluateReverseLondonCrossMarketGuard,
};
