'use strict';

// Owner-set figures are separate from research and model output (BRO-6215).
const OUR_RECOUP_FIELDS = ['ourRecoupEstimatePct', 'ourRecoupEstimateAsOf'];

/** A point or ordered [low, high] percentage, without inventing precision.
 * @returns {[number, number] | null}
 */
function ourRecoupRangePct(entry) {
  const value = entry?.ourRecoupEstimatePct;
  const range = Array.isArray(value) ? value : [value, value];
  if (range.length !== 2 || !range.every(v => Number.isFinite(v) && v >= 0) || range[0] > range[1]) return null;
  return [range[0], range[1]];
}

function isOurRecoupField(field) {
  return OUR_RECOUP_FIELDS.includes(field);
}

// Research may retain the owner's fields, never supply or replace them.
function carryOurRecoupEstimate(result, existing) {
  for (const field of OUR_RECOUP_FIELDS) {
    delete result[field];
    if (existing && Object.hasOwn(existing, field)) result[field] = existing[field];
  }
}

function ourRecoupEstimateErrors(entry) {
  const errors = [];
  if (entry.ourRecoupEstimatePct == null && entry.ourRecoupEstimateAsOf == null) return errors;
  if (!ourRecoupRangePct(entry)) errors.push('ourRecoupEstimatePct must be a finite nonnegative percentage or ordered [low, high] pair');
  const date = entry.ourRecoupEstimateAsOf;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    errors.push('ourRecoupEstimateAsOf must be a valid YYYY-MM-DD date');
  }
  return errors;
}

module.exports = { ourRecoupRangePct, isOurRecoupField, carryOurRecoupEstimate, ourRecoupEstimateErrors };
