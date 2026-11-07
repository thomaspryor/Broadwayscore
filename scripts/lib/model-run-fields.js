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
// BRO-6720: a closed show is paid its NY tax credit after closing, and the
// model's cumulative profit goes negative while the credit is still unpaid or
// uncounted. Cash returned to investors cannot be negative, and a closed show
// with a cited credit gets most of it back whatever its operating loss, so the
// central estimate is at least most of the credit and the high end the whole
// credit. The low end stays where it is.
const CLOSED_CREDIT_CENTRAL_SHARE = 0.75;
const CLOSED_CREDIT_HIGH_SHARE = 1;

/**
 * Raise a closed show's returned-so-far band to the credit floor. The band is
 * profit over capitalization with the counted credit already included (it can
 * be negative for a show that lost money). Only ever raises; returns a new band.
 * @param {number[]} band [low, central, high] as percent of capitalization
 * @param {number} creditPts tax credit counted, in points of capitalization
 */
function closedCreditFloor(band, creditPts) {
  if (!Array.isArray(band) || !(creditPts > 0)) return band;
  const [low, central, high] = band;
  if (![low, central, high].every(Number.isFinite)) return band;
  return [
    low,
    Math.max(central, CLOSED_CREDIT_CENTRAL_SHARE * creditPts),
    Math.max(high, CLOSED_CREDIT_HIGH_SHARE * creditPts),
  ];
}

function isClosedShow(show, comm, now = Date.now()) {
  const close = Date.parse(show && show.closingDate);
  if (!show) return false;
  // An open or previewing show with a stale closing date is still running.
  if (show.status === 'open' || show.status === 'previews') return false;
  return show.status === 'closed' || (Number.isFinite(close) && close < now);
}

function applyReturnedSoFarFields(comm, returned, show) {
  if (!returned || returned.error || !Number.isFinite(returned.recoupmentPctCentral)) {
    delete comm.modelReturnedExCreditPct;
    delete comm.modelTaxCreditExcluded;
    delete comm.modelTaxCreditCounted;
    return;
  }
  let band = [returned.recoupmentPctLow, returned.recoupmentPctCentral, returned.recoupmentPctHigh];
  const counted = returned.taxCreditApplied || 0;
  if (show && isClosedShow(show, comm) && comm.capitalization > 0) {
    band = closedCreditFloor(band, (counted / comm.capitalization) * 100);
  }
  comm.modelReturnedExCreditPct = band;
  comm.modelTaxCreditExcluded = returned.taxCreditExcluded || 0;
  comm.modelTaxCreditCounted = counted;
}

module.exports = {
  clearStaleModelFields, applyShadowReturnFields, applyReturnedSoFarFields, closedCreditFloor, isClosedShow,
  SHADOW_RETURN_FIELDS, RETURNED_SO_FAR_OPTS,
};
