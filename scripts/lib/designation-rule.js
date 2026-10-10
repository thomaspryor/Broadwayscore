'use strict';

/**
 * designation-rule.js — the owner-approved designation rule (BRO-4989,
 * "Re trickle. Yes, A", Thomas 2026-10-10), as one pure function.
 *
 *   Trickle  = recouped, open-ended, returned < 1.5x capitalization
 *   Windfall = recouped, open-ended, returned >= 1.5x
 *   Miracle  = recouped decade-plus mega-hit (existing Miracles that have run
 *              10+ years stay Miracle)
 *   Easy Winner, Nonprofit, Tour Stop: unchanged
 *   Fizzle / Flop: closed without recouping, >= / < 30% returned
 *
 * Only REPORTED figures move a designation (recouped, investorMultiple,
 * estimatedRecoupmentPct). The model tiebreaker is OFF (review session,
 * 2026-10-10: the model is 2.3x off Harry Potter's reported 1.06x, so a
 * model-only move is not made, not even into pending). With it on, the model
 * would decide only when nothing is reported and its range sits clear of the
 * 1.5x line. A result near a boundary is marked confidence 'low'.
 *
 * Shadow only: callers queue a proposed change for pending review with the
 * returned evidence; nothing here writes a designation.
 */

const {
  TRICKLE_MAX_MULTIPLE, MIRACLE_MIN_YEARS, FIZZLE_MIN_RETURNED_PCT, DESIGNATIONS_OUTSIDE_RULE,
} = require('./commercial-designations');
const UNCHANGED = new Set(DESIGNATIONS_OUTSIDE_RULE);
/** Off until the model is explained against reported returns (see header). */
const MODEL_TIEBREAKER = false;
const YEAR_MS = 365.25 * 86400000;

function runYears(show, now) {
  const open = show?.openingDate ? Date.parse(show.openingDate) : null;
  if (!open) return 0;
  const close = show.closingDate ? Math.min(Date.parse(show.closingDate), now) : now;
  return (close - open) / YEAR_MS;
}

/**
 * @param {{ record: object, show: object, model: object|null, now?: number }} p
 *   record: commercial.json entry; model: calculateInvestorReturn() result.
 * @returns {{ designation: string, changed: boolean, basis: string, reason: string }}
 */
function proposeDesignation({ record, show, model, now = Date.now(), modelTiebreaker = MODEL_TIEBREAKER }) {
  const current = record.designation || null;
  const keep = (basis, reason) => ({ designation: current, changed: false, basis, reason, confidence: null });
  const to = (designation, basis, reason, confidence = 'normal') => ({ designation, changed: designation !== current, basis, reason, confidence });

  if (UNCHANGED.has(current)) return keep('unchanged-class', `${current} is outside this rule`);

  const closed = !!(show?.closingDate && Date.parse(show.closingDate) < now);
  const years = runYears(show, now);
  const reported = Number.isFinite(record.investorMultiple) ? record.investorMultiple : null;
  const modelOk = modelTiebreaker && model && !model.error && !(model.sanityFlags || []).length;
  const range = modelOk ? model.investorMultipleRange : null; // [pess, central, opt]

  // Recouped? A reported answer wins; the model decides only when none exists.
  let recouped = record.recouped === true ? true : record.recouped === false ? false : null;
  let recoupBasis = recouped === null ? null : 'reported';
  if (recouped === null && modelOk && closed) { recouped = model.modelRecouped; recoupBasis = 'model'; }

  if (recouped !== true) {
    if (!closed) return keep('running', current === 'TBD' || !current ? 'still running, not recouped' : 'still running; designation kept');
    if (recouped === null) return keep('no-evidence', 'closed, recoupment unknown and no usable model');
    const est = record.estimatedRecoupmentPct; // [low, high] reported estimate
    const pct = Array.isArray(est) && est.every(Number.isFinite) ? (est[0] + est[1]) / 2
      : Number.isFinite(est) ? est
        : modelOk ? model.central.recoupedPct : null;
    if (pct === null) return keep('no-evidence', 'closed unrecouped, no returned % to split Fizzle/Flop');
    if (current === 'Fizzle' || current === 'Flop') return keep('unrecouped', `${current} kept (this rule does not move Fizzle/Flop)`);
    // Near the recoup line, or near the Fizzle/Flop line: low confidence.
    const lowConf = pct >= 80 || Math.abs(pct - FIZZLE_MIN_RETURNED_PCT) < 10;
    return to(pct >= FIZZLE_MIN_RETURNED_PCT ? 'Fizzle' : 'Flop', recoupBasis, `closed without recouping, about ${Math.round(pct)}% returned`, lowConf ? 'low' : 'normal');
  }

  // Recouped, open-ended.
  if (current === 'Miracle' && years >= MIRACLE_MIN_YEARS) return keep('miracle', `decade-plus run (${years.toFixed(1)} yrs) stays Miracle`);

  let multiple;
  let basis;
  if (reported !== null) { multiple = reported; basis = 'reported'; }
  else if (range) {
    if (range[0] < TRICKLE_MAX_MULTIPLE && range[2] >= TRICKLE_MAX_MULTIPLE) {
      return keep('model-uncertain', `model range ${range[0]}x-${range[2]}x straddles ${TRICKLE_MAX_MULTIPLE}x; kept`);
    }
    multiple = range[1]; basis = 'model';
  } else return keep('no-evidence', 'recouped, no reported return and no usable model');

  const src = basis === 'reported' ? `reported ${multiple}x` : `model ${range[0]}x-${range[2]}x (central ${multiple}x)`;
  const conf = multiple < 1.15 || Math.abs(multiple - TRICKLE_MAX_MULTIPLE) < 0.15 ? 'low' : 'normal';
  if (multiple < TRICKLE_MAX_MULTIPLE) return to('Trickle', basis, `recouped, returned under ${TRICKLE_MAX_MULTIPLE}x (${src})`, conf);
  if (current === 'Miracle') return to('Windfall', basis, `Miracle under ${MIRACLE_MIN_YEARS} years (${years.toFixed(1)}), ${src}`, conf);
  return to('Windfall', basis, `recouped, returned ${TRICKLE_MAX_MULTIPLE}x or more (${src})`, conf);
}

module.exports = { proposeDesignation, runYears, MODEL_TIEBREAKER, TRICKLE_MAX_MULTIPLE, MIRACLE_MIN_YEARS, FIZZLE_MIN_RETURNED_PCT };
