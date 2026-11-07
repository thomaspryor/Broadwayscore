'use strict';

/**
 * readiness-market.js: the one market rule check-opening-night-readiness.js
 * applies (BRO-5261). Its checks split only on Broadway vs West End, so
 * route-readiness-failure.js uses the same helpers to decide whether a passing
 * run with a --market override covered the checks that failed.
 */

/** The market a readiness run checks: the override, else the show's category. */
function readinessMarket(override, category) {
  const m = String(override || '').trim();
  return (m && m !== 'auto' ? m : '') || category || 'broadway';
}

/** West End side (west-end, off-west-end), else the Broadway side. */
function isWestEndReadinessMarket(market) {
  return String(market || '').includes('west-end');
}

/**
 * Did a run with this --market override check the same side as the show's
 * own category? No override always does; an unknown show (category null or
 * undefined) with an override does not.
 */
function marketCoversShow({ market, category }) {
  const m = String(market || '').trim();
  if (!m || m === 'auto') return true;
  if (category === undefined || category === null) return false;
  return isWestEndReadinessMarket(readinessMarket(m, category)) === isWestEndReadinessMarket(readinessMarket('', category));
}

module.exports = { readinessMarket, isWestEndReadinessMarket, marketCoversShow };
