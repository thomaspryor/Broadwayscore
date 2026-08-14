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
 * Registered ids AND their aliases map to the same region.
 */
function buildOutletRegionMap(outletRegistry) {
  const outletRegionMap = {};
  for (const [id, info] of Object.entries(outletRegistry.outlets)) {
    // Use explicit region, or infer from market (west-end → london)
    const region = info.region || (info.market === 'west-end' || info.market === 'off-west-end' ? 'london' : null);
    if (region) outletRegionMap[id] = region;
    if (info.aliases && region) {
      for (const alias of info.aliases) {
        outletRegionMap[alias] = region;
      }
    }
  }
  return outletRegionMap;
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
 * @returns {{ shouldFlag: boolean, reason: string|null }}
 */
function evaluateForwardCrossMarketGuard({
  outletRegionMap,
  registeredOutletIds,
  canonicalOutlet,
  rawOutlet,
  url,
  contentVerification,
}) {
  const outletRegion = outletRegionMap[canonicalOutlet] || outletRegionMap[rawOutlet];
  if (outletRegion === 'london') return { shouldFlag: false, reason: null };
  if (isUkUrl(url)) return { shouldFlag: false, reason: null };

  // Don't flag when contentVerification has already affirmatively verified
  // the production is correct with high confidence. [GUARD:CROSS-MARKET-CV-OVERRIDE]
  const cv = contentVerification;
  const cvSaysCorrect = cv && cv.isValid === true
    && cv.wrongProduction === false && cv.confidence === 'high';

  // Bootstrap exemption for COMPLETELY unregistered outlets (task #817).
  const outletIsUnregistered = !registeredOutletIds.has(canonicalOutlet)
    && !registeredOutletIds.has(rawOutlet);

  if (cvSaysCorrect || outletIsUnregistered) {
    return { shouldFlag: false, reason: null };
  }

  return { shouldFlag: true, reason: `Cross-market: US outlet "${rawOutlet}" reviewing London show` };
}

module.exports = {
  classifyReverseCrossMarket,
  classifyCrossMarketContamination,
  classifyUsOnWeCrossMarket,
  buildOutletRegionMap,
  buildRegisteredOutletIds,
  isUkUrl,
  evaluateForwardCrossMarketGuard,
};
