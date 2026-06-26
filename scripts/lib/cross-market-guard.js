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
  const url = (reviewUrl || '').toLowerCase();
  const urlMatchesSibling = !!(url && Array.isArray(best.tokens) && best.tokens.some(t => t && url.includes(t)));

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

module.exports = { classifyReverseCrossMarket, classifyCrossMarketContamination };
