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

module.exports = { classifyReverseCrossMarket };
