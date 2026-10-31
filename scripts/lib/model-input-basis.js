'use strict';

/**
 * model-input-basis.js — which model inputs are guesses (BRO-5849).
 *
 * A guess lives in the field the model already reads (capitalization,
 * weeklyRunningCost) with its confidence beside it: isEstimate.<field>, a
 * source that opens "Estimate: ...", costMethodology reddit-standard or
 * industry-estimate. Nothing here adds a second confidence system. This
 * module reads those markers once and gives the model run a list,
 * stored as modelInputBasis, that merge, display and export share.
 *
 *   [{ input: 'capitalization' | 'weeklyRunningCost', basis }]
 *   basis: 'estimate'     a stated guess (forum figure, press projection, SEC ceiling of an inferred issuer)
 *          'ceiling'      a disclosed maximum (Form D "up to"), a fact about the offering
 *          'type-default' no cost figure: the model used its show-type default
 *          'comparables'  no figure: filled from similar shows (set by cap-comparables, shadow first)
 *
 * dataQuality stays high/medium/low; the display floor only rejects 'low'.
 */

const { ownReturnedEstimatePct } = require('./commercial-designations');
const { sourceOpensAsEstimate, isMaximumCapitalization } = require('./public-source-text');

const GUESS_COST_METHODS = Object.freeze(['reddit-standard', 'industry-estimate']);
/** Bases that make a figure a guess: they may not decide a public loss label. */
const GUESS_BASES = Object.freeze(['estimate', 'comparables']);

/**
 * @param {object} comm commercial record (as the model read it)
 * @param {{ weeklyFixedCostSource?: string, capitalizationEstimate?: object }} [result] model result
 * @returns {Array<{input: string, basis: string}>}
 */
function modelInputBasis(comm, result) {
  const out = [];
  if (!comm) return out;
  if (comm.capitalization) {
    if (comm.isEstimate?.capitalization === true || sourceOpensAsEstimate(comm.capitalizationSource)) out.push({ input: 'capitalization', basis: 'estimate' });
    else if (isMaximumCapitalization(comm)) out.push({ input: 'capitalization', basis: 'ceiling' });
  } else if (result && result.capitalizationEstimate) {
    out.push({ input: 'capitalization', basis: 'comparables' });
  }
  if (comm.weeklyRunningCost) {
    if (comm.isEstimate?.weeklyRunningCost === true || sourceOpensAsEstimate(comm.weeklyRunningCostSource) || GUESS_COST_METHODS.includes(comm.costMethodology)) {
      out.push({ input: 'weeklyRunningCost', basis: 'estimate' });
    }
  } else if (result && result.weeklyFixedCostSource === 'estimated') {
    out.push({ input: 'weeklyRunningCost', basis: 'type-default' });
  }
  return out;
}

/** True when a stored basis list holds a guess or comparable (not a ceiling or type default). */
function decidedByGuess(entry) {
  return Array.isArray(entry?.modelInputBasis) && entry.modelInputBasis.some((b) => GUESS_BASES.includes(b.basis));
}

/**
 * May this record's loss label be re-sized by the model? Not when a guess
 * decided the estimate; the record's own analyst/outside estimate still can.
 */
function canResizeByModel(entry) {
  return !decidedByGuess(entry) || ownReturnedEstimatePct(entry) !== null;
}

module.exports = { modelInputBasis, decidedByGuess, canResizeByModel, GUESS_BASES, GUESS_COST_METHODS };
