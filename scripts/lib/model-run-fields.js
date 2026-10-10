'use strict';

/**
 * model-run-fields.js — per-record field writes shared by merge-model-recoupment.js
 * (BRO-4989 G). The shadow fields sit beside the live ones; nothing on the
 * site reads them (toPublicShowCommercial is an allowlist) until a reviewed switch.
 *
 *   modelRecoupmentPctV2  - SVOG-denominator fix, [pessimistic, central, optimistic] %
 *   modelInvestorMultiple - investor return multiple after the 50/50 split, same order
 *
 * modelRecoupmentPct is never touched here.
 */

const { modelReturnV2 } = require('./model-return-v2');

const SHADOW_RETURN_FIELDS = ['modelRecoupmentPctV2', 'modelInvestorMultiple'];

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

module.exports = { clearStaleModelFields, applyShadowReturnFields, SHADOW_RETURN_FIELDS };
