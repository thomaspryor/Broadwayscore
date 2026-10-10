'use strict';

/**
 * model-return-v2.js — the SVOG-denominator fix on its own (BRO-4989 change
 * 1 of 2, reviewed and switched separately from dated costs).
 *
 * The live model measures recoupment against cap MINUS the SVOG grant. When
 * the grant is close to the cap, the denominator collapses to about the
 * reserve fund and the % explodes (Chicago 95,786%, DEH 22,506%). The fix
 * counts the grant as money in and divides by the full capitalization:
 *
 *   live:  cumProfit / (cap - svog [+ reserve])
 *   v2:   (cumProfit + svog) / (cap [+ reserve])
 *
 * The recouped line does not move (cumProfit + svog >= cap is the same test
 * as cumProfit >= cap - svog), except for closed shows whose grant leaves
 * less than one week's nut of cap (svog > cap - weeklyNut), where live floors
 * its denominator at the nut. Below the line the two agree to within the
 * grant's share; above it v2 stays proportional.
 *
 * classifyTier is LIVE-CRITICAL: merge-model-recoupment.js routes every show
 * through it. Changing it changes the live model.
 *
 * Also the investor multiple after the standard 50/50 split above recoupment:
 *   distributable = cumProfit + svog (- reserve while running)
 *   multiple = (min(D, cap) + 0.5 x max(D - cap, 0)) / cap, floored at 0
 *
 * Pure: takes a calculateRecoupment / calculateLifetimeRecoupment result.
 * Uses the live model's costs, weeks and scenarios unchanged.
 */

const LONG_RUN_WEEKS = 520; // 10 years
const INVESTOR_SHARE_ABOVE_CAP = 0.5;

/** Which live calculation a record gets (moved verbatim from merge-model-recoupment.js). */
function classifyTier(show, comm, grossesAllTime) {
  if (!comm.capitalization) return 'ai-estimated';
  if (!grossesAllTime) return 'ai-estimated';

  // Calculate run length
  const open = show.openingDate ? new Date(show.openingDate) : null;
  const close = show.closingDate ? new Date(show.closingDate) : new Date();
  const runWeeks = open ? Math.round((close - open) / (7 * 86400000)) : 0;

  if (runWeeks >= LONG_RUN_WEEKS) return 'simplified-lifetime';
  return 'weekly-model';
}

/**
 * @param {object} result - live model result (capitalization, svogGrant, reserveFund, optimistic/central/pessimistic.cumulativeProfit)
 * @param {object} show - shows.json record
 * @param {number} [now]
 * @returns {{ recoupmentPctV2: number[], investorMultiple: number[], recouped: boolean, denominator: number }|null}
 *   arrays are [pessimistic, central, optimistic], like modelRecoupmentPct.
 */
/** Closed exactly as recoupment-model.js decides it: a date strictly in the past. */
function isClosed(show, now = Date.now()) {
  return !!(show?.closingDate && Date.parse(show.closingDate) < now);
}

function modelReturnV2(result, show, now = Date.now()) {
  if (!result || result.error) return null;
  const cap = result.capitalization;
  if (!(cap > 0)) return null;
  const svog = result.svogGrant || 0;
  const closed = isClosed(show, now);
  const reserve = closed ? 0 : (result.reserveFund || 0);
  const denominator = cap + reserve;

  const pct = [];
  const mult = [];
  for (const name of ['pessimistic', 'central', 'optimistic']) {
    const p = result[name].cumulativeProfit + svog;
    pct.push(Math.round((p / denominator) * 1000) / 10);
    const d = p - reserve;
    const m = (Math.min(d, cap) + INVESTOR_SHARE_ABOVE_CAP * Math.max(d - cap, 0)) / cap;
    mult.push(Math.round(Math.max(m, 0) * 100) / 100);
  }
  // Unrounded, like live modelRecouped: 99.96% is not recouped.
  const recouped = result.central.cumulativeProfit + svog >= denominator;
  return { recoupmentPctV2: pct, investorMultiple: mult, recouped, denominator };
}

module.exports = { modelReturnV2, classifyTier, isClosed, LONG_RUN_WEEKS, INVESTOR_SHARE_ABOVE_CAP };
