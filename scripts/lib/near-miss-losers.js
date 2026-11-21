'use strict';
/**
 * near-miss-losers.js (BRO-6191): the loss-side signal the ground-truth
 * backtest lacked. A show the truth says never recouped scores error 0 at any
 * central below 100%, so a default-cost cut that lifts loss-labelled shows from
 * 40% to 95% reads "no group worse". This names the rows that moved to the edge:
 *
 *   near-miss losers: truth kind 'failed', new central >= 90% while old was
 *     below 90%. (A model-set label, designationBasis 'model-estimate', without
 *     recouped:false is never a failed-truth row, so it cannot appear here.)
 *   unsourced crossings: records with no outcome on file (recouped neither
 *     true nor false) whose new central crosses 100% while old was below it.
 *
 * Advisory only (CLAUDE.md §19): printed beside "New false recouped", never
 * counted toward --strict. Pure functions (CLAUDE.md §15); the CLI is
 * scripts/backtest-recoupment-ground-truth.js, the star-play-only guard is
 * star-play-loss-side.test.mjs (BRO-6178).
 */

const NEAR_MISS_PCT = 90;
const RECOUPED_PCT = 100;

const noOutcomeOnFile = (comm) => !comm || (comm.recouped !== true && comm.recouped !== false);

/** Failed-truth rows the new side lifts to the near-miss line. */
function nearMissLosers(rows, threshold = NEAR_MISS_PCT) {
  return rows.filter((r) => r.kind === 'failed'
    && r.newPct >= threshold && !(r.oldPct >= threshold));
}

/** Records with no recouped outcome whose new central crosses 100% while old did not. */
function unsourcedCrossings(entries, threshold = RECOUPED_PCT) {
  return entries.filter((e) => e.noOutcome !== false && e.newPct >= threshold && !(e.oldPct >= threshold));
}

/** One printable line; names only when `names` (public CI logs print counts). */
function nearMissLine(losers, crossings, { names = true } = {}) {
  const list = (items) => (items.length && names ? ` (${items.map((r) => `${r.slug} ${Math.round(r.oldPct)} -> ${Math.round(r.newPct)}`).join(', ')})` : '');
  return `Near-miss losers (advisory): ${losers.length} failed-truth rows now >= ${NEAR_MISS_PCT}% (were below)${list(losers)}; `
    + `${crossings.length} unsourced rows (recouped undefined) now >= ${RECOUPED_PCT}%${list(crossings)}`;
}

module.exports = { nearMissLosers, unsourcedCrossings, nearMissLine, noOutcomeOnFile, NEAR_MISS_PCT, RECOUPED_PCT };
