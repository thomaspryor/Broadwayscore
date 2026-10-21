'use strict';

/**
 * model-run-fields.js — per-record field writes shared by merge-model-recoupment.js
 * (BRO-4989 G). The shadow fields sit beside the live ones; nothing on the
 * site reads them (toPublicShowCommercial is an allowlist) until a reviewed switch.
 *
 *   modelRecoupmentPctV2  - SVOG-denominator fix, [pessimistic, central, optimistic] %
 *   modelInvestorMultiple - investor return multiple after the 50/50 split, same order
 *   modelReturnedExCreditPct - "% returned so far": played weeks only, and a
 *                           running show's NY tax credit only once cited as
 *                           received (checker decisions #1/#2, B2), same order
 *   modelTaxCreditExcluded - the uncited credit left out of it ($), for the
 *                           "Not counting an expected NY State tax credit" line
 *   modelTaxCreditCounted - the credit inside it ($): above 0 means the figure
 *                           is post-credit (displayBasis, BRO-5073)
 *
 * modelRecoupmentPct is never touched here.
 */

const { modelReturnV2 } = require('./model-return-v2');

const SHADOW_RETURN_FIELDS = ['modelRecoupmentPctV2', 'modelInvestorMultiple', 'modelReturnedExCreditPct', 'modelTaxCreditExcluded', 'modelTaxCreditCounted'];
/** Model options for the "% returned so far" shadow run. */
const RETURNED_SO_FAR_OPTS = Object.freeze({ playedWeeksOnly: true, taxCreditCitedOnly: true });

/**
 * On any fall-back to ai-estimated, fields from a prior weekly/lifetime run
 * must not survive (a stale modelRecouped=false would sit in the
 * model-false-negative audit metric forever).
 */
function clearStaleModelFields(comm) {
  delete comm.modelRecoupmentPct;
  delete comm.modelRecouped;
  delete comm.modelBreakeven;
  delete comm.modelCostBasis;
  delete comm.modelCategory;
  delete comm.modelWarnings;
  delete comm.modelInputBasis;
  delete comm.modelCapitalizationEstimate;
  // A contradiction belongs to the discarded run, not the AI fallback.
  delete comm.modelDesignationFlag;
  // A run that now errors (a split run, BRO-5515) must not keep the old
  // run's grade; the ai-estimated passthrough sets its own.
  delete comm.modelDataQuality;
  for (const f of SHADOW_RETURN_FIELDS) delete comm[f];
}

/**
 * Write the shadow return fields from a live model result. Clears them when
 * the result cannot be scored (no capitalization), so a stale run never stays.
 * @returns {object|null} the modelReturnV2 output
 */
function applyShadowReturnFields(comm, result, show, now = Date.now()) {
  const v2 = modelReturnV2(result, show, now);
  if (!v2) {
    for (const f of SHADOW_RETURN_FIELDS) delete comm[f];
    return null;
  }
  comm.modelRecoupmentPctV2 = v2.recoupmentPctV2;
  comm.modelInvestorMultiple = v2.investorMultiple;
  return v2;
}

/**
 * Write the "% returned so far" shadow fields from a run with
 * RETURNED_SO_FAR_OPTS. A missing or failed run clears them.
 */
function applyReturnedSoFarFields(comm, returned) {
  if (!returned || returned.error || !Number.isFinite(returned.recoupmentPctCentral)) {
    delete comm.modelReturnedExCreditPct;
    delete comm.modelTaxCreditExcluded;
    delete comm.modelTaxCreditCounted;
    return;
  }
  comm.modelReturnedExCreditPct = [returned.recoupmentPctLow, returned.recoupmentPctCentral, returned.recoupmentPctHigh];
  comm.modelTaxCreditExcluded = returned.taxCreditExcluded || 0;
  comm.modelTaxCreditCounted = returned.taxCreditApplied || 0;
}

module.exports = {
  clearStaleModelFields, applyShadowReturnFields, applyReturnedSoFarFields,
  SHADOW_RETURN_FIELDS, RETURNED_SO_FAR_OPTS,
};
